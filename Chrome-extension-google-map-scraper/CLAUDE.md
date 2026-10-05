# Maps Lead Scraper — Chrome Extension

## Project Overview

A production-ready Chrome Extension (Manifest V3) that scrapes business leads from Google Maps with no API key, no backend, and no external dependencies. Pure vanilla JavaScript.

**Extension Name:** Maps Lead Scraper  
**Version:** 1.0.0  
**Platform:** Chrome / Chromium (MV3)

---

## File Structure

```
Chrome-extension-google-map-scraper/
├── manifest.json        — MV3 manifest, permissions, host rules
├── content.js           — Phase 1: auto-scroll & collect cards
├── background.js        — Phase 2: service worker enrichment engine
├── popup.html           — Extension popup UI (700px wide)
├── popup.css            — Dark theme styles
├── popup.js             — Popup UI controller
├── generate-icons.js    — Zero-dependency Node.js icon generator
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## manifest.json

- **Manifest version:** 3
- **Permissions:** `activeTab`, `scripting`, `storage`, `downloads`, `tabs`, `unlimitedStorage`
- **Host permissions:** `https://www.google.com/maps/*`
- **Content scripts:** `content.js` injected at `document_idle` on all Maps pages
- **Background:** `background.js` registered as a service worker
- **Icons:** 16, 48, 128 px from `icons/` directory

---

## Architecture: Two-Phase Scrape

### Phase 1 — Scroll & Collect (`content.js`)

Injected into the active Google Maps tab. Responsibilities:
1. Locates the results feed panel via `SEL.feed`
2. Auto-scrolls `feed.scrollTop = feed.scrollHeight` every `SCROLL_INTERVAL` (1200 ms)
3. Extracts card data with `extractCard()` after each scroll
4. Deduplicates by `name||address` key
5. Stops after `MAX_STALE = 3` scroll passes with no new cards, or after `MAX_DURATION = 90000 ms`
6. Sends `SCRAPE_PROGRESS` messages to popup during scroll
7. Returns final `{ success, timedOut, results[] }` to popup via `sendResponse`

**What Phase 1 collects per card:**
| Field | Source |
|-------|--------|
| `name` | `.qBF1Pd` text, fallback `aria-label` on card link |
| `rating` | `.MW4etd` text |
| `reviewCount` | `.UY7F9` text (parens stripped) |
| `category` | First short non-bullet span in `.W4Efsd` |
| `address` | `.W4Efsd` span containing digit or comma |
| `isOpen` | `.eXlrNe, .ZkP5Je, .o0svFd` text |
| `googleMapsUrl` | `href` of `a.hfpxzc` card link |
| `phone` | empty — filled by Phase 2 |
| `website` | empty — filled by Phase 2 |

### Phase 2 — Enrichment Engine (`background.js`)

Service worker. Receives `START_ENRICH` message from popup with the Phase 1 leads array. For each lead:
1. Opens a **hidden background tab** (`active: false`) at `biz.googleMapsUrl`
2. Waits for `status === 'complete'` (timeout: `TAB_LOAD_TIMEOUT_MS = 20000 ms`)
3. Waits extra `EXTRACT_WAIT_MS = 1800 ms` for Maps' dynamic content
4. Injects `extractDetailData()` via `chrome.scripting.executeScript`
5. Extracts phone from `a[href^="tel:"]` and website from `a[data-item-id="authority"]`
6. Closes the tab in `finally` block (always runs, even on error)
7. Sends `ENRICH_PROGRESS` to popup after each lead
8. Rate-limits with `INTER_TAB_DELAY_MS = 700 ms` between tabs
9. Saves incremental progress to `chrome.storage.local` (`enrichJob`) so popup can reconnect
10. Adds finished leads to the persistent **Lead Bank** (max 1000)
11. Sends `ENRICH_COMPLETE` with final leads + bank size

**Storage keys used by background.js:**
| Key | Content |
|-----|---------|
| `enrichJob` | `{ status, current, total, leads[] }` — live job state |
| `lastResults` | Final enriched leads array |
| `lastScrapedAt` | Locale time string of last completion |
| `leadBankSize` | Current bank count |
| `leadBank` | Cumulative array of up to 1000 leads |

---

## Selector Map (`content.js` SEL object)

All Google Maps CSS selectors are centralised in `SEL` at the top of `content.js`. **Only update here if Google changes classes.**

```js
const SEL = {
  feed:        '.m6QErb[role="feed"]',        // scrollable results panel
  card:        '.Nv2PK, .THOPZb, .lI9IFe',   // business card wrappers
  name:        '.qBF1Pd',
  rating:      '.MW4etd',
  reviewCount: '.UY7F9',
  openStatus:  '.eXlrNe, .ZkP5Je, .o0svFd',
  cardLink:    'a.hfpxzc',                    // Maps place URL
};
```

**Phase 2 detail selectors** (in `background.js` `extractDetailData`):
- Phone: `a[href^="tel:"]` → `href.replace('tel:', '')`
- Website: `a[data-item-id="authority"]` → `.href`
- Website fallback: `a[data-tooltip][href^="http"]` → `.href`

---

## popup.html / popup.css / popup.js

### UI Layout (700 px wide dark theme)

```
┌─────────────────────────────────────────────┐
│ Header:  icon + "Maps Lead Scraper" | badge + dot │
├─────────────────────────────────────────────┤
│ Controls: [▶ Start Scrape] [↓ Export CSV] [× Clear] │
├─────────────────────────────────────────────┤
│ Status bar  (phase text)                    │
├─────────────────────────────────────────────┤
│ Progress bar + scroll counter               │
├─────────────────────────────────────────────┤
│ Filter row: Min rating: [All▼]  Showing N of M │
├─────────────────────────────────────────────┤
│ Results table (max-height 300px, scrollable) │
│ Name | Rating | Reviews | Category | Address | Phone | Website │
├─────────────────────────────────────────────┤
│ Lead Bank bar: 📈 Lead Bank N/1000 [↓ Export All] [🗑 Clear Bank] │
├─────────────────────────────────────────────┤
│ Footer: last scraped time | "Only scrapes publicly visible data" │
└─────────────────────────────────────────────┘
```

### CSS Design Tokens

```css
--bg:        #0f0f1a    /* main background */
--card:      #1a1a2e    /* header / controls / footer */
--card2:     #16213e    /* table header, progress track */
--accent:    #00d4ff    /* cyan highlight, links, titles */
--accent2:   #0099bb    /* gradient end */
--green:     #00c97a    /* scrape button, status-dot active, high-rated rows */
--red:       #ff4d6d    /* error border */
--text:      #e0e0f0
--text-dim:  #8888aa
```

### Popup State Machine

| `isScraping` | Phase | UI State |
|---|---|---|
| false | idle | Scrape enabled, Export depends on results |
| true | Phase 1 | Scrape disabled, fake progress bar animating |
| true | Phase 2 | Scrape disabled, real progress bar, rows updating in-place |
| false | done | Both enabled, `ENRICH_COMPLETE` received |

### Popup Startup Restore Logic

On every popup open, reads `chrome.storage.local` and:
- If `enrichJob.status === 'running'` → reconnects to live Phase 2 (shows partial results, listens for `ENRICH_PROGRESS`)
- If `enrichJob.status === 'done'` → restores fully enriched results
- Else if `lastResults` exists → restores last scrape results
- Always updates Lead Bank counter from `leadBank`

### Message Protocol

| Message type | Direction | Payload |
|---|---|---|
| `START_SCRAPE` | popup → content | — |
| `SCRAPE_PROGRESS` | content → popup | `{ count, scrollPass }` |
| `START_ENRICH` | popup → background | `{ leads[] }` |
| `ENRICH_PROGRESS` | background → popup | `{ current, total, lead }` |
| `ENRICH_COMPLETE` | background → popup | `{ leads[], bankSize }` |
| `PING` | popup → background/content | — (keep-alive) |
| `PONG` | background/content → popup | — |

### CSV Export

Headers: `Name, Rating, Reviews, Category, Address, Phone, Website, Maps URL, Open Status`

- BOM (`\uFEFF`) prepended for correct Excel UTF-8 rendering
- Values are RFC-4180 escaped (quotes + newlines handled)
- Export respects the active rating filter
- Lead Bank export always exports all 1000 saved leads
- Filename format: `gmaps-leads-YYYY-MM-DDTHH-MM.csv` / `gmaps-bank-YYYY-MM-DDTHH-MM.csv`

### Table Behaviour

- Rows are clickable — opens the business's Google Maps URL in a new tab
- Rows with `rating >= 4.5` get the `.high-rated` green-tinted background
- Phone/website cells show a blinking `…` placeholder while Phase 2 is running
- In-place row updates via `rowMap` (keyed by `googleMapsUrl`) — no full table re-render during enrichment

---

## generate-icons.js

Zero-dependency Node.js script. Run with:

```bash
node generate-icons.js
```

Generates `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`.

**Implementation details:**
- Implements a minimal PNG encoder from scratch (IHDR + IDAT + IEND chunks, zlib deflate, CRC32)
- Draws a map-pin icon: anti-aliased filled circles (head) + filled triangle (tail) + white inner dot
- Colour scheme matches extension accent: `#005aa0` border → `#00b4e6` mid → `#00d4ff` highlight
- No canvas, no npm packages, runs in any Node.js version

---

## Lead Bank

- Persistent cumulative storage: up to **1000 leads** across all scrapes
- Stored in `chrome.storage.local` under key `leadBank`
- Deduplication key: `name||address`
- When bank hits 1000, oldest entries are trimmed from the front
- Separate export (`gmaps-bank-*.csv`) and clear controls in popup

---

## Known Limitations / Maintenance Notes

1. **Selector brittleness** — Google changes Maps CSS classes without notice. If scraping breaks, inspect a business card in DevTools and update `SEL` in `content.js`. Phone/website selectors are in `extractDetailData` in `background.js`.

2. **Rate limiting** — `INTER_TAB_DELAY_MS = 700 ms` between enrichment tabs. Increase this value if Google starts serving CAPTCHAs or empty pages during Phase 2.

3. **90-second Phase 1 timeout** — `MAX_DURATION = 90000`. Increase for very large searches.

4. **Service worker lifecycle** — The popup sends a `PING` every 25 seconds to keep the service worker alive during enrichment. If Chrome terminates it between pings, `chrome.storage.local` keeps job state intact for reconnect.

5. **No parallel enrichment** — Phase 2 opens tabs one at a time (sequential). This is intentional to avoid Google rate-limiting.

6. **Content script re-injection** — `popup.js` calls `chrome.scripting.executeScript` with `files: ['content.js']` before each scrape. If already injected, the `catch(() => {})` swallows the harmless "already injected" error.

---

## How to Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project folder
5. Navigate to `google.com/maps`, search for a business type, then click the extension icon

---

## Development Rules

- All Google Maps selectors live only in `SEL` (content.js) and `extractDetailData` (background.js). Never hardcode selectors elsewhere.
- No external libraries, no npm, no build step. Plain ES2020+ JS.
- Icons are regenerated by running `node generate-icons.js` — never edit PNG files manually.
- Keep `chrome.storage.local` keys consistent across all three JS files (see storage key table above).
- Phase 2 tabs must always be opened with `active: false` — never steal focus from the user's active tab.
- All `chrome.runtime.sendMessage` calls in loops must have `.catch(() => {})` — popup may be closed.
