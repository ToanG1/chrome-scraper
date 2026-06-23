# chrome-scraper

A production-ready Google SERP / MEO scraper built on **raw Chrome DevTools Protocol (CDP)** — no Puppeteer, no Playwright. Controls a real Chrome browser via WebSocket inside Docker with Xvfb + noVNC.

## Features

- **Raw CDP** — direct WebSocket communication with Chrome, zero browser automation frameworks
- **Persistent session** — single Chrome tab reused across all queries (natural browsing history + cookie trust)
- **Profile persistence** — Chrome profile stored in a Docker named volume; survives `docker compose restart`
- **MEO batch endpoint** — one call fetches all keywords for a location using the hybrid approach (0 CAPTCHA in 50-request tests)
- **Location targeting** — `uule=lat,lon` on `google.co.jp` correctly pins the Maps local pack to any Japanese city, no proxy required after profile warmup
- **Idle browsing** — background loop opens organic Google search results in new tabs to continuously build NID cookie trust
- **CTR signals** — every real API request also opens a linked business website in a background tab (fire-and-forget)
- **Stealth JS** — masks `navigator.webdriver`, spoofs WebGL renderer/vendor, canvas noise, hardware concurrency, device memory, plugins, `window.chrome`
- **CAPTCHA detection + recovery** — detects `/sorry/` redirects, clears session cookies/cache via CDP, resumes automatically
- **Per-request proxy** — isolated browser context per request via `Target.createBrowserContext`
- **noVNC** — watch Chrome live at `http://localhost:6080/vnc.html`
- **TypeScript** — fully typed, runs via `tsx` with no build step

---

## Quick Start

```bash
git clone https://github.com/ToanG1/chrome-scraper.git
cd chrome-scraper
docker compose up -d
```

Wait ~15 seconds for Chrome to start:

```bash
curl http://localhost:3000/health
# → { "status": "ok", "browser": "Chrome/149.x.x.x" }
```

> **Important:** Run the container for at least **24 hours** before production use.
> The idle browsing loop builds NID cookie trust during this time.
> A cold profile will get CAPTCHA'd almost immediately on parameterised SERP URLs.

---

## API

### `GET /health`
Returns Chrome version and server status.

### `POST /fetch/meo-batch` — recommended production endpoint

Runs the full hybrid flow (1 direct URL → N `searchInBox`) for a location batch in a single call. Proven 0 CAPTCHA in 50-request tests across 5 Japanese cities.

**lat/lon shorthand:**
```bash
curl -X POST http://localhost:3000/fetch/meo-batch \
  -H "Content-Type: application/json" \
  -d '{
    "lat": 35.6762,
    "lon": 139.6503,
    "keywords": ["sushi", "ramen", "居酒屋", "カフェ", "ホテル"],
    "html": false
  }'
```

**Custom URL template (full param control):**
```bash
curl -X POST http://localhost:3000/fetch/meo-batch \
  -H "Content-Type: application/json" \
  -d '{
    "templateUrl": "https://www.google.co.jp/search?q={query}&hl=ja&gl=jp&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1&uule=35.6762,139.6503",
    "keywords": ["sushi", "ramen", "居酒屋"]
  }'
```

`{query}` is replaced with `encodeURIComponent(keyword)` for the first keyword. Subsequent keywords use the search box (no parameterised URL → no CAPTCHA risk).

**Response** (one entry per keyword):
```json
[
  { "keyword": "sushi",  "method": "url", "ok": true, "bytes": 718000, "meo": true },
  { "keyword": "ramen",  "method": "box", "ok": true, "bytes": 718000, "meo": true },
  { "keyword": "居酒屋", "method": "box", "ok": true, "bytes": 718000, "meo": true }
]
```

| Field | Type | Notes |
|-------|------|-------|
| `lat` / `lon` | number | Target coordinates (shorthand form) |
| `templateUrl` | string | Must contain `{query}` literal (template form) |
| `keywords` | string[] | 1–20 keywords; first uses direct URL, rest use search box |
| `html` | boolean | Include full HTML in response (default `true`); `false` for metadata only |

---

### `POST /fetch/meo`
Single direct URL fetch. Use this when you want to call one keyword at a time or manage the hybrid flow yourself.

```bash
curl -X POST http://localhost:3000/fetch/meo \
  -H "Content-Type: application/json" \
  -d '{"query":"sushiro","lat":35.689487,"lon":139.691711}'
```

Returns raw HTML. Session location is locked to `lat`/`lon` for the next `/fetch/search-in-box` calls.

### `POST /fetch/search-in-box`
Types a new keyword into the search box of the current SERP. Google keeps the location context set by the previous `/fetch/meo` call.

```bash
curl -X POST http://localhost:3000/fetch/search-in-box \
  -H "Content-Type: application/json" \
  -d '{"query":"ラーメン"}'
```

### `POST /fetch/meo-organic`
Organic flow: navigates to `google.co.jp` homepage → types keyword in omnibox → clicks the Maps tab. No parameterised URL. Used as a CAPTCHA fallback when direct URL is blocked.

Accepts optional `lat`/`lon` for geolocation override + direct URL first attempt.

### `POST /fetch/seo`
Organic SERP pinned to coordinates.

| Field | Type |
|-------|------|
| `query` | string |
| `lat` | number |
| `lon` | number |

### `POST /search`
Structured JSON output — organic results, featured snippet, total count.

| Field | Type |
|-------|------|
| `query` | string |
| `pages` | number (1–10) |

### `POST /search/batch`
Up to 20 queries in one call. Same fields as `/search` plus `queries: string[]`.

### `POST /fetch`
Raw URL fetch — navigates Chrome to any URL and returns HTML. Optional `proxy` creates an isolated browser context.

| Field | Type |
|-------|------|
| `url` | string |
| `proxy` | string? (`http://user:pass@host:port`) |
| `warmUpQuery` | string? | Do a plain Google search first (once per session) |

---

## Location Targeting

### How it works

`uule=lat,lon` on `google.co.jp` correctly pins the Maps local pack to any Japanese city **from any IP** — provided the Chrome profile has at least 24 hours of NID cookie trust built up.

```
https://www.google.co.jp/search?q=sushi&hl=ja&gl=jp&pws=0&npsic=0
  &rflfq=1&rldoc=1&rlha=0&sa=X&udm=1&uule=35.6762,139.6503
```

Google also checks `Emulation.setGeolocationOverride` (Chrome's Geolocation API). The scraper sets both before every `/fetch/meo` call.

### CAPTCHA tolerance by approach

| Approach | Profile | Result |
|---|---|---|
| Direct URL every request, cold profile | Fresh | Immediate CAPTCHA (request 1) |
| Direct URL every request, warmed profile | 24h warmup | CAPTCHA after ~5 consecutive requests |
| **Hybrid: 1 direct URL + searchInBox after** | **24h warmup** | **0/50 CAPTCHA** ✓ |

See [FINDINGS.md](FINDINGS.md) for full details.

---

## Profile Warmup

The idle browsing loop runs continuously in the background:

- **5 permanent idle tabs** — Google Maps + 4 themed search tabs (food, beauty, local, news)
- Each cycle: organic Google search → extract result URLs → open in new background tab → scroll → optionally follow a same-domain link → close tab
- **CTR on real requests** — every `/fetch/meo` call also opens the first linked business URL in a background tab (fire-and-forget)
- Interval: 3–8 minutes between cycles; 90-second cooldown after any real API request

After 24 hours: ~1.5 GB profile, 1,200+ cookies across 344 domains, active NID on `google.com` and `google.co.jp`.

---

## Architecture

```
src/
├── index.ts      Hono HTTP server — all routes
├── scraper.ts    CDP session, navigation, fetchMeoBatch, idle tab management
├── browser.ts    CDPSession WebSocket wrapper, tab helpers
├── idle.ts       Background idle loop (3–8 min intervals)
├── parser.ts     Cheerio HTML parser (organic SERP selectors)
└── stealth.ts    Anti-detection JS injected before page scripts

test/
├── serp-url-test.ts    Hybrid stress test: 5 cities × 10 keywords (50 req, 0 CAPTCHA)
├── direct-url-test.ts  Full direct URL test: measures raw CAPTCHA tolerance
├── stress.ts           General SERP stress test
└── keywords.ts         100 keywords (EN / JA)
```

### Request flow (`/fetch/meo-batch`)

```
Client → POST /fetch/meo-batch { lat, lon, keywords }
  │
  ├─ keywords[0] → fetchUrl(uule URL)
  │    ├─ humanSearch warmup (first session only)
  │    ├─ Page.navigate → Maps local pack SERP
  │    ├─ assertNoCaptcha
  │    ├─ scrollPage
  │    └─ openResultTabAsync → browseUrlInNewTab (background, no await)
  │
  ├─ keywords[1..N] → searchInBox
  │    ├─ xdoClick search box → xdoReplaceText → Enter
  │    ├─ assertNoCaptcha
  │    └─ scrollPage
  │
  └─ return [{ keyword, method, ok, bytes, meo, html }]
```

### CAPTCHA handling

```
1. assertNoCaptcha checks document.location.href via CDP after every navigation
2. URL contains /sorry/ → _captchaHit = true, closeSession(), throw CaptchaError
3. Next getSession() sees _captchaHit = true:
   → Network.clearBrowserCookies + Network.clearBrowserCache
   → Storage.clearDataForOrigin for google.com + google.co.jp
   → _captchaHit = false, fresh tab, stealth JS + geolocation re-applied
```

> **Note:** Cookie clear resets NID trust. Recovery takes ~30–60 min of idle browsing.
> Prevention: always use the hybrid flow (max 1 direct URL per location group).

---

## Docker

```yaml
services:
  serp-scraper:
    build: .
    ports:
      - "3000:3000"   # API
      - "6080:6080"   # noVNC
    volumes:
      - chrome-profile:/tmp/chrome-profile   # profile persistence across restarts
    shm_size: "2gb"
    environment:
      - PORT=3000
      - PROXY_SERVER=   # optional: host:port for global Chrome proxy

volumes:
  chrome-profile:
```

The container runs as the non-root `node` user — Chrome doesn't need `--no-sandbox`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `PROXY_SERVER` | _(none)_ | Global proxy for Chrome (`host:port`). Per-request proxy via `/fetch` body takes precedence. |

## Tech Stack

- **Runtime**: Node.js 20, TypeScript via `tsx`
- **HTTP**: [Hono](https://hono.dev) + `@hono/node-server`
- **Browser**: Google Chrome (real, headed), controlled via raw CDP WebSocket
- **Parsing**: [Cheerio](https://cheerio.js.org)
- **Display**: Xvfb + x11vnc + noVNC
- **Input**: xdotool (keyboard/mouse simulation) + xsel (clipboard for CJK text)
- **Fonts**: `fonts-noto`, `fonts-noto-cjk` (Japanese support)
