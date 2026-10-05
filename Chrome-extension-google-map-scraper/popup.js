// popup.js — Maps Lead Scraper UI controller
// Phase 1 (scroll):  content.js → popup  via chrome.tabs.sendMessage
// Phase 2 (enrich):  background.js → popup via chrome.runtime.sendMessage
// Lead Bank:         chrome.storage.local, up to 1000 cumulative leads

(function () {
  'use strict';

  // ─── DOM refs ──────────────────────────────────────────────────────────────
  const btnScrape      = document.getElementById('btn-scrape');
  const btnExport      = document.getElementById('btn-export');
  const btnClear       = document.getElementById('btn-clear');
  const btnBankExport  = document.getElementById('btn-bank-export');
  const btnBankClear   = document.getElementById('btn-bank-clear');
  const statusText     = document.getElementById('status-text');
  const statusDot      = document.getElementById('status-dot');
  const countBadge     = document.getElementById('count-badge');
  const progressWrap   = document.getElementById('progress-wrap');
  const progressBar    = document.getElementById('progress-bar');
  const scrollCounter  = document.getElementById('scroll-counter');
  const filterRow      = document.getElementById('filter-row');
  const filterRating   = document.getElementById('filter-rating');
  const showingCount   = document.getElementById('showing-count');
  const errorBox       = document.getElementById('error-box');
  const tbody          = document.getElementById('results-tbody');
  const emptyState     = document.getElementById('empty-state');
  const toast          = document.getElementById('toast');
  const lastScraped    = document.getElementById('last-scraped');
  const bankBar        = document.getElementById('bank-bar');
  const bankCount      = document.getElementById('bank-count');

  // ─── State ─────────────────────────────────────────────────────────────────
  let allResults   = [];        // current scrape results (may be partially enriched)
  let rowMap       = new Map(); // googleMapsUrl → <tr> for in-place updates
  let isScraping   = false;
  let toastTimeout = null;
  let fakeProgressInterval = null;
  let fakeProgress = 0;

  // ─── Keep-alive ping ───────────────────────────────────────────────────────
  const keepAlive = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'PING' }).catch(() => {});
  }, 25000);
  window.addEventListener('unload', () => clearInterval(keepAlive));

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function setStatus(msg, state = 'idle') {
    statusText.textContent = msg;
    statusDot.className    = `status-dot ${state}`;
  }

  function showToast(msg, duration = 2800) {
    clearTimeout(toastTimeout);
    toast.textContent = msg;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 280);
    }, duration);
  }

  function updateBadge(count) {
    countBadge.textContent = count;
    countBadge.classList.toggle('hidden', count === 0);
  }

  function updateBankUI(count) {
    if (!bankCount) return;
    bankCount.textContent = `${count} / 1000`;
    if (btnBankExport) btnBankExport.disabled = count === 0;
    if (bankBar) bankBar.classList.toggle('hidden', count === 0);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function csvEscape(val) {
    if (val == null) return '';
    const s = String(val);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  // ─── Progress bar ──────────────────────────────────────────────────────────
  function startProgress() {
    fakeProgress = 5;
    progressBar.style.width = fakeProgress + '%';
    progressWrap.classList.remove('hidden');
    fakeProgressInterval = setInterval(() => {
      if (fakeProgress < 88) { fakeProgress += Math.random() * 1.5; progressBar.style.width = fakeProgress + '%'; }
    }, 900);
  }

  function setProgress(pct) {
    clearInterval(fakeProgressInterval);
    progressBar.style.width = pct + '%';
    progressWrap.classList.remove('hidden');
  }

  function finishProgress() {
    clearInterval(fakeProgressInterval);
    progressBar.style.width = '100%';
    setTimeout(() => progressWrap.classList.add('hidden'), 900);
  }

  function stopProgress() {
    clearInterval(fakeProgressInterval);
    progressWrap.classList.add('hidden');
    progressBar.style.width = '0%';
  }

  // ─── Table rendering (full redraw) ─────────────────────────────────────────
  function renderTable(results) {
    tbody.innerHTML = '';
    rowMap.clear();

    if (!results.length) {
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';

    const minRating = parseFloat(filterRating.value) || 0;
    const filtered  = minRating
      ? results.filter((b) => { const r = parseFloat(b.rating); return !isNaN(r) && r >= minRating; })
      : results;

    showingCount.textContent = `Showing ${filtered.length} of ${results.length}`;

    filtered.forEach((biz) => {
      const tr = document.createElement('tr');
      if (parseFloat(biz.rating) >= 4.5) tr.classList.add('high-rated');
      tr.addEventListener('click', () => { if (biz.googleMapsUrl) chrome.tabs.create({ url: biz.googleMapsUrl }); });

      const websiteCell = buildWebsiteCell(biz.website);

      tr.innerHTML = `
        <td class="td-name"    title="${escapeHtml(biz.name)}">${escapeHtml(biz.name)}</td>
        <td class="td-rating">${biz.rating ? '★ ' + escapeHtml(biz.rating) : '—'}</td>
        <td>${escapeHtml(biz.reviewCount) || '—'}</td>
        <td title="${escapeHtml(biz.category)}">${escapeHtml(biz.category) || '—'}</td>
        <td title="${escapeHtml(biz.address)}">${escapeHtml(biz.address) || '—'}</td>
        <td class="td-phone">${escapeHtml(biz.phone) || '<span class="pending-dot">…</span>'}</td>
        <td class="td-website">${websiteCell}</td>
      `;

      rowMap.set(biz.googleMapsUrl, tr);
      tbody.appendChild(tr);
    });

    showingCount.textContent = `Showing ${filtered.length} of ${results.length}`;
  }

  function buildWebsiteCell(website) {
    if (!website) return '<span class="td-no-website pending-dot">…</span>';
    const display = website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    return `<a href="${escapeHtml(website)}" target="_blank" title="${escapeHtml(website)}" onclick="event.stopPropagation()">${escapeHtml(display)}</a>`;
  }

  // ─── In-place row update (called on each ENRICH_PROGRESS) ─────────────────
  function updateRow(lead) {
    const tr = rowMap.get(lead.googleMapsUrl);
    if (!tr) return;

    const cells = tr.querySelectorAll('td');
    if (cells.length < 7) return;

    // Phone (index 5)
    cells[5].innerHTML = lead.phone ? escapeHtml(lead.phone) : '<span class="td-dim">—</span>';

    // Website (index 6)
    if (lead.website) {
      const display = lead.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      cells[6].className = 'td-website';
      cells[6].innerHTML = `<a href="${escapeHtml(lead.website)}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(display)}</a>`;
    } else {
      cells[6].className = 'td-website td-dim';
      cells[6].innerHTML = '—';
    }
  }

  // ─── Global Phase-2 message handler (registered at startup) ───────────────
  // Must be at top level so it catches messages even after popup close+reopen.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ENRICH_PROGRESS') {
      const { current, total, lead } = message;

      // Update progress UI
      scrollCounter.textContent = `Enriching… (${current} / ${total})`;
      scrollCounter.classList.add('enriching');
      setStatus(`Phase 2: Fetching details… (${current} of ${total})`, 'active');
      setProgress(Math.round((current / total) * 100));
      progressWrap.classList.remove('hidden');

      // Merge into allResults and update the row in-place
      if (lead) {
        const idx = allResults.findIndex((b) => b.googleMapsUrl === lead.googleMapsUrl);
        if (idx !== -1) {
          allResults[idx].phone   = lead.phone;
          allResults[idx].website = lead.website;
        }
        updateRow(lead);
      }
    }

    if (message.type === 'ENRICH_COMPLETE') {
      const { leads = [], bankSize = 0 } = message;
      allResults = leads;

      finishProgress();
      scrollCounter.classList.remove('enriching');
      scrollCounter.textContent = `Done — ${leads.length} leads enriched`;

      const count = leads.length;
      setStatus(`Complete! ${count} businesses scraped with full details.`, 'done');
      showToast(`${count} leads complete! Bank: ${bankSize}/1000`);
      updateBadge(count);
      updateBankUI(bankSize);
      renderTable(allResults);  // final clean render

      filterRow.classList.toggle('hidden', count === 0);
      btnExport.disabled = count === 0;
      btnScrape.disabled = false;
      isScraping = false;

      const scrapedAt = new Date().toLocaleTimeString();
      lastScraped.textContent = `Last scraped: ${scrapedAt}`;
    }
  });

  // ─── Phase 1 — scroll & collect ───────────────────────────────────────────
  async function startScrape() {
    if (isScraping) return;

    errorBox.classList.add('hidden');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('google.com/maps')) {
      errorBox.classList.remove('hidden');
      setStatus('Not on Google Maps.', 'idle');
      return;
    }

    isScraping   = true;
    btnScrape.disabled  = true;
    btnExport.disabled  = true;
    allResults   = [];
    rowMap.clear();

    setStatus('Phase 1: Scanning results…', 'active');
    startProgress();
    filterRow.classList.add('hidden');
    scrollCounter.textContent = 'Scrolling… (0)';
    scrollCounter.classList.remove('enriching');

    // Phase 1 progress listener (temporary — only during scroll phase)
    const p1Handler = (message) => {
      if (message.type === 'SCRAPE_PROGRESS') {
        const count = message.count || 0;
        scrollCounter.textContent = `Scrolling… (${count} found, pass ${message.scrollPass || '?'})`;
        setStatus(`Phase 1: Found ${count} businesses…`, 'active');
        updateBadge(count);
      }
    };
    chrome.runtime.onMessage.addListener(p1Handler);

    try {
      // Ensure content script is injected
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files:  ['content.js'],
      }).catch(() => {}); // ignore if already injected

      const response = await chrome.tabs.sendMessage(tab.id, { type: 'START_SCRAPE' });
      chrome.runtime.onMessage.removeListener(p1Handler);

      if (!response?.success) {
        setStatus(response?.error || 'Scrape failed — check you are on Google Maps.', 'idle');
        stopProgress();
        isScraping = false;
        btnScrape.disabled = false;
        return;
      }

      const phase1 = response.results || [];
      if (!phase1.length) {
        setStatus('No results found. Search for a business type first.', 'idle');
        stopProgress();
        isScraping = false;
        btnScrape.disabled = false;
        return;
      }

      // ── Phase 1 done: render basic table, then hand off to background ──────
      allResults = phase1;
      renderTable(allResults);
      updateBadge(allResults.length);
      filterRow.classList.remove('hidden');

      setStatus(`Phase 1 done: ${phase1.length} found. Fetching phone & website…`, 'active');
      scrollCounter.textContent = `Enriching… (0 / ${phase1.length})`;
      scrollCounter.classList.add('enriching');
      setProgress(0);

      // Save running job state (popup can reconnect if closed)
      chrome.storage.local.set({
        enrichJob: { status: 'running', current: 0, total: phase1.length, leads: phase1 },
      });

      // Fire Phase 2 in background service worker — results come via ENRICH_PROGRESS
      chrome.runtime.sendMessage({ type: 'START_ENRICH', leads: phase1 }).catch(() => {});

    } catch (err) {
      chrome.runtime.onMessage.removeListener(p1Handler);
      stopProgress();
      isScraping = false;
      btnScrape.disabled = false;
      console.error('[Maps Lead Scraper]', err);
      setStatus('Error: ' + (err.message || 'Unknown — check you are on Google Maps.'), 'idle');
    }
  }

  // ─── Export CSV (current view / filtered) ─────────────────────────────────
  function exportCSV(leads, filename) {
    if (!leads.length) return;
    const headers = ['Name', 'Rating', 'Reviews', 'Category', 'Address', 'Phone', 'Website', 'Maps URL', 'Open Status'];
    const rows    = leads.map((b) =>
      [b.name, b.rating, b.reviewCount, b.category, b.address,
       b.phone, b.website, b.googleMapsUrl, b.isOpen].map(csvEscape)
    );
    const csv  = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function onExportClick() {
    if (!allResults.length) return;
    const minRating = parseFloat(filterRating.value) || 0;
    const toExport  = minRating
      ? allResults.filter((b) => { const r = parseFloat(b.rating); return !isNaN(r) && r >= minRating; })
      : allResults;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    exportCSV(toExport, `gmaps-leads-${stamp}.csv`);
    showToast(`Exported ${toExport.length} leads!`);
  }

  function onBankExportClick() {
    chrome.storage.local.get('leadBank', ({ leadBank = [] }) => {
      if (!leadBank.length) return;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      exportCSV(leadBank, `gmaps-bank-${stamp}.csv`);
      showToast(`Exported ${leadBank.length} bank leads!`);
    });
  }

  // ─── Clear current results ─────────────────────────────────────────────────
  function clearResults() {
    allResults = [];
    rowMap.clear();
    tbody.innerHTML  = '';
    emptyState.style.display = 'block';
    filterRow.classList.add('hidden');
    btnExport.disabled = true;
    updateBadge(0);
    setStatus('Cleared. Ready to scrape.', 'idle');
    lastScraped.textContent = '';
    chrome.storage.local.remove(['lastResults', 'lastScrapedAt', 'enrichJob']);
  }

  // ─── Clear lead bank ───────────────────────────────────────────────────────
  function clearBank() {
    chrome.storage.local.remove(['leadBank', 'leadBankSize'], () => {
      updateBankUI(0);
      showToast('Lead bank cleared.');
    });
  }

  // ─── Restore state on popup open ──────────────────────────────────────────
  chrome.storage.local.get(
    ['enrichJob', 'lastResults', 'lastScrapedAt', 'leadBank'],
    (data) => {
      // Update bank counter
      updateBankUI((data.leadBank || []).length);

      const job = data.enrichJob;

      if (job?.status === 'running') {
        // Background is mid-enrichment — reconnect UI
        allResults = job.leads || [];
        renderTable(allResults);
        updateBadge(allResults.length);
        filterRow.classList.remove('hidden');

        isScraping        = true;
        btnScrape.disabled = true;
        setStatus(`Phase 2: Enriching… (${job.current} / ${job.total})`, 'active');
        scrollCounter.textContent = `Enriching… (${job.current} / ${job.total})`;
        scrollCounter.classList.add('enriching');
        setProgress(job.total > 0 ? Math.round((job.current / job.total) * 100) : 0);
        // Global ENRICH_PROGRESS listener (registered above) will continue updating

      } else if (job?.status === 'done' && job.leads?.length) {
        // Enrichment finished while popup was closed
        allResults = job.leads;
        renderTable(allResults);
        updateBadge(allResults.length);
        filterRow.classList.remove('hidden');
        btnExport.disabled = false;
        setStatus(`Restored ${allResults.length} enriched results.`, 'done');
        chrome.storage.local.get('lastScrapedAt', ({ lastScrapedAt }) => {
          if (lastScrapedAt) lastScraped.textContent = `Last scraped: ${lastScrapedAt}`;
        });

      } else if (data.lastResults?.length) {
        // Last basic results (pre-enrichment or partial)
        allResults = data.lastResults;
        renderTable(allResults);
        updateBadge(allResults.length);
        filterRow.classList.remove('hidden');
        btnExport.disabled = false;
        setStatus(`Restored ${allResults.length} results from last scrape.`, 'done');
        if (data.lastScrapedAt) lastScraped.textContent = `Last scraped: ${data.lastScrapedAt}`;
      }
    }
  );

  // ─── Filter change ─────────────────────────────────────────────────────────
  filterRating.addEventListener('change', () => renderTable(allResults));

  // ─── Button bindings ───────────────────────────────────────────────────────
  btnScrape.addEventListener('click', startScrape);
  btnExport.addEventListener('click', onExportClick);
  btnClear.addEventListener('click', clearResults);
  if (btnBankExport) btnBankExport.addEventListener('click', onBankExportClick);
  if (btnBankClear)  btnBankClear.addEventListener('click', clearBank);
})();
