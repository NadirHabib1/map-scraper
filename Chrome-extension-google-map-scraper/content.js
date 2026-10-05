// content.js — Phase 1: Scroll & Collect
// Injected into https://www.google.com/maps/* pages.
// Only scrolls the results feed and collects basic card data.
// Phone + website are fetched by background.js (Phase 2) via separate tabs.

(function () {
  'use strict';

  // ─── Selector constants ────────────────────────────────────────────────────
  // Update these if Google changes their CSS classes — nowhere else needed.
  const SEL = {
    feed:        '.m6QErb[role="feed"]',
    card:        '.Nv2PK, .THOPZb, .lI9IFe',   // business card wrappers
    name:        '.qBF1Pd',
    rating:      '.MW4etd',
    reviewCount: '.UY7F9',
    openStatus:  '.eXlrNe, .ZkP5Je, .o0svFd',
    cardLink:    'a.hfpxzc',
  };

  const MAX_STALE        = 3;
  const SCROLL_INTERVAL  = 1200; // ms between scroll attempts
  const MAX_DURATION     = 90000; // 90s max for Phase 1

  let scraping = false;

  // ─── DOM helpers ──────────────────────────────────────────────────────────
  function text(el, sel) {
    try {
      const found = sel ? el.querySelector(sel) : el;
      return found ? found.textContent.trim() : '';
    } catch { return ''; }
  }

  function attr(el, sel, attribute) {
    try {
      const found = sel ? el.querySelector(sel) : el;
      return found ? (found.getAttribute(attribute) || '') : '';
    } catch { return ''; }
  }

  // ─── Extract one business card ─────────────────────────────────────────────
  function extractCard(card) {
    try {
      // Name
      let name = text(card, SEL.name);
      if (!name) name = attr(card, SEL.cardLink, 'aria-label') || '';

      // Rating
      const rating = text(card, SEL.rating);

      // Review count — strip parentheses
      const reviewCount = text(card, SEL.reviewCount).replace(/[()]/g, '').trim();

      // Category — first short non-bullet span inside .W4Efsd
      let category = '';
      for (const span of card.querySelectorAll('.W4Efsd span')) {
        const t = span.textContent.trim();
        if (t && !t.startsWith('·') && t.length < 60) { category = t; break; }
      }

      // Address — W4Efsd span that contains a digit or comma
      let address = '';
      for (const span of card.querySelectorAll('.W4Efsd')) {
        const t = span.textContent.trim();
        if (t && (t.match(/\d/) || t.includes(','))) {
          address = t.replace(/·/g, '').trim();
          break;
        }
      }
      if (!address) address = attr(card, '[data-tooltip]', 'data-tooltip');

      // Google Maps URL (unique per place — used as key in Phase 2)
      const mapsLinkEl    = card.querySelector(SEL.cardLink);
      const googleMapsUrl = mapsLinkEl ? mapsLinkEl.href : window.location.href;

      // Open/closed status
      let isOpen = '';
      const statusEl = card.querySelector(SEL.openStatus);
      if (statusEl) {
        const s = statusEl.textContent.trim().toLowerCase();
        if (s.includes('open'))            isOpen = 'Open';
        else if (s.includes('clos'))       isOpen = 'Closed';
        else                               isOpen = statusEl.textContent.trim();
      }

      // phone + website are empty here; background.js fills them in Phase 2
      return { name, rating, reviewCount, category, address,
               phone: '', website: '', googleMapsUrl, isOpen };
    } catch (err) {
      console.warn('[Maps Lead Scraper] extractCard error:', err);
      return null;
    }
  }

  // ─── Deduplicate by name + address ────────────────────────────────────────
  function dedup(results) {
    const seen = new Set();
    return results.filter((b) => {
      const key = `${b.name}||${b.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ─── Main scroll loop ──────────────────────────────────────────────────────
  async function startScrape() {
    console.log('[Maps Lead Scraper] Phase 1 start');

    const feed = document.querySelector(SEL.feed);
    if (!feed) {
      return {
        success: false,
        error: 'Results panel not found. Search for businesses on Google Maps first.',
        results: [],
      };
    }

    let all         = [];
    let stale       = 0;
    let scrollPass  = 0;
    let timedOut    = false;
    let prevCount   = 0;
    const t0        = Date.now();

    function extractVisible() {
      const out = [];
      document.querySelectorAll(SEL.card).forEach((card) => {
        const b = extractCard(card);
        if (b && b.name) out.push(b);
      });
      return out;
    }

    function sendProgress(count, pass) {
      chrome.runtime.sendMessage({ type: 'SCRAPE_PROGRESS', count, scrollPass: pass })
        .catch(() => {});
    }

    // Initial extraction before first scroll
    all = dedup(extractVisible());
    sendProgress(all.length, 0);

    while (stale < MAX_STALE) {
      if (Date.now() - t0 > MAX_DURATION) {
        timedOut = true;
        console.warn('[Maps Lead Scraper] Phase 1 timeout');
        break;
      }

      scrollPass++;
      feed.scrollTop = feed.scrollHeight;
      await new Promise((r) => setTimeout(r, SCROLL_INTERVAL));

      const merged = dedup([...all, ...extractVisible()]);
      if (merged.length > prevCount) {
        stale = 0;
      } else {
        stale++;
        console.log(`[Maps Lead Scraper] Stale ${stale}/${MAX_STALE}`);
      }
      prevCount = merged.length;
      all = merged;
      sendProgress(all.length, scrollPass);
    }

    console.log('[Maps Lead Scraper] Phase 1 done:', all.length, 'cards');
    return { success: true, timedOut, results: all };
  }

  // ─── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'START_SCRAPE') {
      if (scraping) {
        sendResponse({ success: false, error: 'Scrape already in progress.' });
        return true;
      }
      scraping = true;
      startScrape()
        .then((result) => { scraping = false; sendResponse(result); })
        .catch((err)   => {
          scraping = false;
          console.error('[Maps Lead Scraper]', err);
          sendResponse({ success: false, error: err.message || 'Unknown error', results: [] });
        });
      return true; // keep channel open for async response
    }

    if (message.type === 'PING') { sendResponse({ type: 'PONG' }); return true; }
  });

  console.log('[Maps Lead Scraper] Content script ready');
})();
