# chrome-scraper

A production-ready Google SERP scraper built on **raw Chrome DevTools Protocol (CDP)** — no Puppeteer, no Playwright. Controls a real Chrome browser via WebSocket, runs headed inside Docker with noVNC for visual access.

## Features

- **Raw CDP** — direct WebSocket communication with Chrome, zero browser automation frameworks
- **Persistent session** — single Chrome tab reused across all queries (natural browsing history)
- **MEO / SEO endpoints** — location-pinned SERP fetching via `sll`/`fll` parameters (no proxy needed)
- **Multi-page** — scrape 1–10 result pages per query (`&start=N` pagination)
- **Human-like behavior** — random scrolling, result click-throughs, random site visits between searches
- **Stealth JS** — masks `navigator.webdriver`, spoofs WebGL renderer, hardware concurrency, device memory
- **CAPTCHA detection + auto-recovery** — detects `/sorry/` redirects, clears cookies/cache via CDP, resumes automatically
- **Per-request proxy** — isolated browser context per request via `Target.createBrowserContext` (no Chrome restart)
- **Geolocation** — auto-detects public IP coordinates via ip-api.com, injects via `Emulation.setGeolocationOverride`
- **noVNC** — watch the browser live at `http://localhost:6080/vnc.html`
- **TypeScript** — fully typed, runs via `tsx` with no build step

## Quick Start

```bash
git clone https://github.com/ToanG1/chrome-scraper.git
cd chrome-scraper
docker compose up -d
```

Wait ~10 seconds for Chrome to start, then:

```bash
# Health check
curl http://localhost:3000/health

# MEO — sushi near Shinjuku, Tokyo
curl -X POST http://localhost:3000/fetch/meo \
  -H "Content-Type: application/json" \
  -d '{"query":"sushi","lat":35.689487,"lon":139.691711}'

# SEO — organic sushi results near Tokyo
curl -X POST http://localhost:3000/fetch/seo \
  -H "Content-Type: application/json" \
  -d '{"query":"sushi","lat":35.689487,"lon":139.691711}'
```

Open **http://localhost:6080/vnc.html** in your browser to watch Chrome in real time.

## API

### `GET /health`
Returns Chrome version and server status.

```json
{ "status": "ok", "browser": "Chrome/149.0.7827.114" }
```

### `POST /search`
Organic SERP scraper with structured JSON output.

| Field | Type | Description |
|-------|------|-------------|
| `query` | string | Search query |
| `pages` | number | Pages to scrape (1–10, default 1) |

```json
{
  "query": "nodejs best practices",
  "organic": [
    { "title": "...", "url": "...", "snippet": "...", "page": 1 }
  ],
  "featuredSnippet": null,
  "totalResults": 47,
  "pagesScraped": 1,
  "scrapedAt": "2026-06-17T10:00:00.000Z"
}
```

### `POST /search/batch`
| Field | Type | Description |
|-------|------|-------------|
| `queries` | string[] | Up to 20 queries |
| `pages` | number | Pages per query (1–10) |

### `POST /fetch/meo`
Fetches Google Maps / local pack results for a specific coordinate.
Returns raw HTML — parse with Cheerio for structured data.

| Field | Type | Description |
|-------|------|-------------|
| `query` | string | Search query (e.g. `"sushi"`) |
| `lat` | number | Latitude of the target location |
| `lon` | number | Longitude of the target location |

```bash
curl -X POST http://localhost:3000/fetch/meo \
  -H "Content-Type: application/json" \
  -d '{"query":"ラーメン","lat":34.6937,"lon":135.5023}'
```

### `POST /fetch/seo`
Fetches 100 organic results pinned to a coordinate via `sll`.

| Field | Type | Description |
|-------|------|-------------|
| `query` | string | Search query |
| `lat` | number | Latitude |
| `lon` | number | Longitude |

### `POST /fetch`
Raw URL fetch — navigate Chrome to any custom URL and return HTML.
Optionally pass `proxy` to route through a specific IP.

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Full URL to fetch |
| `proxy` | string? | `http://user:pass@host:port` — creates isolated browser context |

---

## Location Targeting (MEO / SEO)

### How it works

Google SERP location is controlled by two independent systems:

| System | Parameter | Controls |
|--------|-----------|----------|
| Search location | `sll`, `fll` | Which area Google searches in |
| Browser location | `Emulation.setGeolocationOverride` | What the browser reports as GPS |
| Footer display | IP geolocation | The "● City" shown in the footer |

The footer showing **不明** (unknown) is normal when running from a non-JP server — it reflects the browser's GPS permission, not the search area. The `sll`/`fll` parameters control actual search results independently.

### sll / fll parameters

These are the parameters Google adds when you click **"Search this area"** on a Maps result page. They define a geographic viewport for the search:

```
sll=35.689487,139.691711   — search center (lat,lon)
fll=35.689487,139.691711   — map focus center (same value)
fspn=0.04,0.065            — viewport span (~4km radius)
sspn=0.04,0.065            — search span
fz=14 / sz=14              — zoom level
stq=1                      — "search this area" flag
cs=0
```

**Key finding:** `sll`/`fll` work from **any IP address** — no proxy or VPN required. The raw `uule=lat,lon` format does NOT work without a matching IP.

### Why raw uule=lat,lon fails

```
uule=35.689487,139.691711   ← Google ignores this when IP doesn't match
sll=35.689487,139.691711    ← Google uses this regardless of IP ✓
```

Google only respects raw coordinate `uule` values when the request IP geolocates to the same country. The `sll` "search this area" parameters bypass this restriction entirely.

### Why uule city-name encoding also fails

The base64 city-name `uule` format (`w+CAIQICI...`) requires an exact canonical location name from Google's geocoding database. Common formats like `"Tokyo, Japan"` or `"Tokyo,japan"` are not recognized and silently fall back to IP geolocation.

### Per-request proxy (optional)

For cases where you need precise IP matching (e.g. integrating with Bright Data's residential proxy network), the `/fetch` endpoint accepts a `proxy` parameter. Chrome creates an **isolated browser context** (`Target.createBrowserContext`) for each proxied request — no shared cookies, no Chrome restart:

```bash
curl -X POST http://localhost:3000/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://www.google.co.jp/search?q=sushi&udm=1&sll=35.689487,139.691711",
    "proxy": "http://user-country-jp-city-tokyo:pass@gateway.brightdata.com:24000"
  }'
```

---

## Architecture

```
src/
├── index.ts      Hono HTTP server (routes: /search, /fetch, /fetch/meo, /fetch/seo)
├── scraper.ts    CDP session, navigation, human-like behaviors, proxy context
├── browser.ts    CDPSession class, tab helpers, browser context helpers
├── parser.ts     Cheerio HTML parser (Google organic SERP selectors)
└── stealth.ts    Anti-detection JS injected before page scripts

test/
├── keywords.ts        100 keywords (English / Vietnamese / Japanese)
├── stress.ts          Stress test: 100 keywords × N pages with pacing
└── serp-url-test.ts   MEO + SEO location test: 5 cities × 10 keywords × 2 types
```

### How it works

1. On first request, opens a Chrome tab via `PUT /json/new` and connects via WebSocket
2. Injects stealth JS via `Page.addScriptToEvaluateOnNewDocument`
3. Sets geolocation to match public IP via `Emulation.setGeolocationOverride` + `Browser.grantPermissions`
4. For `/fetch/meo` and `/fetch/seo`: builds URL with `sll`/`fll` coordinates, navigates, scrolls, returns HTML
5. For `/search`: navigates `google.com/search?q=...`, parses organic results with Cheerio
6. Between searches (40% chance): visits a random developer site (GitHub, MDN, HN, etc.)
7. After page 1 (35% chance): clicks through to a top-3 organic result, dwells, returns
8. Tab is never closed — session cookie and history persist across queries

### CAPTCHA handling

Google flags automation by storing a CAPTCHA token in the Chrome profile cookies (`/tmp/chrome-profile`). Once flagged, every subsequent request to Google immediately redirects to `/sorry/`.

**Automatic resolution flow:**

```
1. After every navigation, check document.location.href via CDP
2. URL contains /sorry/ → CAPTCHA detected
3. Set _captchaHit = true, close tab, throw CaptchaError (HTTP 500)
4. Next request calls getSession() → sees _captchaHit = true
5. Network.clearBrowserCookies + Network.clearBrowserCache via CDP
   (equivalent to docker compose down && up — wipes the CAPTCHA flag)
6. _captchaHit = false, fresh geolocation + stealth JS injected
7. Scraping continues normally
```

Verified live: 8 CAPTCHAs auto-resolved in a single 20-keyword batch run.

---

## Stress Test

```bash
# Against local Docker
npx tsx test/stress.ts

# Against remote
API_URL=http://your-server:3000 npx tsx test/stress.ts
```

## MEO + SEO Location Test

```bash
npx tsx test/serp-url-test.ts
```

Tests 5 Japanese cities × 10 keywords × 2 types (MEO + SEO) = 100 requests.
Verifies that `meo=true` / `seo=true` signal presence in returned HTML for each location.

---

## Docker

```yaml
services:
  serp-scraper:
    build: .
    ports:
      - "3000:3000"   # API
      - "6080:6080"   # noVNC
    shm_size: "2gb"
    environment:
      - PORT=3000
      - PROXY_SERVER=   # optional: http://user:pass@host:port for global Chrome proxy
```

The container runs as the non-root `node` user so Chrome doesn't need `--no-sandbox`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `CHROME_DEBUG_URL` | `http://localhost:9222` | Chrome DevTools endpoint |
| `PROXY_SERVER` | _(none)_ | Global proxy for Chrome (all requests). Per-request proxy via `/fetch` body takes precedence. |

## Tech Stack

- **Runtime**: Node.js 20, TypeScript via `tsx`
- **HTTP**: [Hono](https://hono.dev) + `@hono/node-server`
- **Browser**: Google Chrome (real, headed), controlled via raw CDP WebSocket
- **Parsing**: [Cheerio](https://cheerio.js.org)
- **Display**: Xvfb + x11vnc + noVNC
- **Fonts**: `fonts-noto`, `fonts-noto-cjk` (Vietnamese + Japanese support)
