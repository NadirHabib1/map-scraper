// background.js — Service Worker / Phase 2 Enrichment Engine
// Opens each business URL in a silent background tab, extracts phone+website,
// then closes it. No navigation happens in the user's active tab — eliminates
// the bfcache message-port-closed error entirely.

'use strict';

const TAB_LOAD_TIMEOUT_MS = 20000; // max wait for a tab to reach 'complete'
const EXTRACT_WAIT_MS     = 1800;  // wait after 'complete' for dynamic content
const INTER_TAB_DELAY_MS  = 700;   // pause between tabs (rate-limiting)

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Waits for a specific tab to reach status 'complete'.
 * Resolves on complete or after TAB_LOAD_TIMEOUT_MS (best-effort).
 */
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handler);
      console.warn('[Maps Lead Scraper] Tab load timeout for', tabId);
      resolve();
    }, TAB_LOAD_TIMEOUT_MS);

    function handler(updatedId, changeInfo) {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(handler);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(handler);
  });
}

/**
 * Extraction function injected into each detail tab via executeScript.
 * Runs in the context of the Maps place page — no shared scope with background.
 */
function extractDetailData() {
  try {
    // Phone: Google renders it as a tel: link
    const phoneEl = document.querySelector('a[href^="tel:"]');
    const phone   = phoneEl ? phoneEl.href.replace('tel:', '').trim() : '';

    // Website: authority link (the external website button)
    const webEl   = document.querySelector('a[data-item-id="authority"]');
    const website = webEl ? (webEl.href || '') : '';

    // Fallback website selector used on some layouts
    const webAlt  = !website ? (document.querySelector('a[data-tooltip][href^="http"]')?.href || '') : '';

    return { phone, website: website || webAlt };
  } catch {
    return { phone: '', website: '' };
  }
}

// ── Lead Bank (persistent storage, up to 1000 leads) ─────────────────────────

async function addToLeadBank(newLeads) {
  const { leadBank = [] } = await chrome.storage.local.get('leadBank');
  const seen = new Set(leadBank.map((l) => `${l.name}||${l.address}`));
  const unique = newLeads.filter((l) => l.name && !seen.has(`${l.name}||${l.address}`));
  // Keep most recent 1000 — append new, trim from front
  const combined = [...leadBank, ...unique].slice(-1000);
  await chrome.storage.local.set({ leadBank: combined });
  return combined.length;
}

// ── Main enrichment loop ──────────────────────────────────────────────────────

async function enrichLeads(leads) {
  const total   = leads.length;
  const enriched = leads.map((l) => ({ ...l })); // shallow copy to avoid mutating original

  console.log('[Maps Lead Scraper] Background enrichment started:', total, 'leads');

  for (let i = 0; i < total; i++) {
    const biz = enriched[i];

    // Save incremental progress to storage so popup can reconnect if closed
    await chrome.storage.local.set({
      enrichJob: { status: 'running', current: i, total, leads: enriched },
    });

    let tab = null;
    try {
      // Open the Maps place page in a hidden background tab
      tab = await chrome.tabs.create({ url: biz.googleMapsUrl, active: false });
      console.log(`[Maps Lead Scraper] Enriching (${i + 1}/${total}): ${biz.name} [tab ${tab.id}]`);

      // Wait for the page to fully load
      await waitForTabComplete(tab.id);

      // Give Maps' dynamic content extra time to render
      await sleep(EXTRACT_WAIT_MS);

      // Extract phone + website via content injection
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func:   extractDetailData,
      });

      if (results?.[0]?.result) {
        const { phone, website } = results[0].result;
        if (phone)   enriched[i].phone   = phone;
        if (website) enriched[i].website = website;
      }

    } catch (err) {
      console.warn(`[Maps Lead Scraper] Enrichment failed for "${biz.name}":`, err.message);
      // Continue — never abort the whole loop for one failure
    } finally {
      // Always close the tab
      if (tab?.id) {
        chrome.tabs.remove(tab.id).catch(() => {});
      }
    }

    // Notify popup of this lead's completion
    chrome.runtime.sendMessage({
      type:    'ENRICH_PROGRESS',
      current: i + 1,
      total,
      lead:    enriched[i],
    }).catch(() => {}); // popup may be closed — ignore

    // Rate-limit: pause between tabs to avoid triggering Google rate-limiting
    if (i < total - 1) {
      await sleep(INTER_TAB_DELAY_MS);
    }
  }

  // Add enriched leads to the persistent bank
  const bankSize = await addToLeadBank(enriched);

  // Mark job as done
  await chrome.storage.local.set({
    enrichJob:    { status: 'done', current: total, total, leads: enriched },
    lastResults:  enriched,
    lastScrapedAt: new Date().toLocaleTimeString(),
    leadBankSize:  bankSize,
  });

  // Notify popup that we're done
  chrome.runtime.sendMessage({
    type:     'ENRICH_COMPLETE',
    leads:    enriched,
    bankSize,
  }).catch(() => {});

  console.log('[Maps Lead Scraper] Enrichment complete. Bank size:', bankSize);
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_ENRICH') {
    const leads = message.leads || [];
    // Fire-and-forget — results flow back via sendMessage + storage
    enrichLeads(leads).catch((err) => {
      console.error('[Maps Lead Scraper] Background enrichment crashed:', err);
      chrome.storage.local.set({ enrichJob: { status: 'error', error: err.message } });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' });
    return true;
  }
});

// ── Installation ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Maps Lead Scraper] Installed v' + chrome.runtime.getManifest().version);
  }
  if (details.reason === 'update') {
    // Clear stale job state on update
    chrome.storage.local.remove('enrichJob');
  }
});
