# chrome-scraper

A production-ready Google SERP scraper built on **raw Chrome DevTools Protocol (CDP)** — no Puppeteer, no Playwright. Controls a real Chrome browser via WebSocket, runs headed inside Docker with noVNC for visual access.

## Features

- **Raw CDP** — direct WebSocket communication with Chrome, zero browser automation frameworks
- **Persistent session** — single Chrome tab reused across all queries (natural browsing history)
- **Multi-page** — scrape 1–10 result pages per query (`&start=N` pagination)
- **Human-like behavior** — random scrolling, result click-throughs, random site visits between searches
- **Stealth JS** — masks `navigator.webdriver`, spoofs WebGL renderer, hardware concurrency, device memory
- **CAPTCHA detection** — detects `/sorry/` redirects, resets session, throws typed `CaptchaError`
- **Geolocation** — auto-detects public IP coordinates via ip-api.com, injects via `Emulation.setGeolocationOverride`
- **noVNC** — watch the browser live at `http://localhost:6080/vnc.html`
- **TypeScript** — fully typed, runs via `tsx` with no build step
- **Hono** HTTP server with `/search` and `/search/batch` endpoints

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

# Single query, 3 pages
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{"query": "nodejs best practices", "pages": 3}'

# Batch
curl -X POST http://localhost:3000/search/batch \
  -H "Content-Type: application/json" \
  -d '{"queries": ["react tutorial", "typescript generics"], "pages": 2}'
```

Open **http://localhost:6080/vnc.html** in your browser to watch Chrome in real time.

## API

### `GET /health`
Returns Chrome version and server status.

```json
{ "status": "ok", "browser": "Chrome/149.0.7827.114" }
```

### `POST /search`
| Field | Type | Description |
|-------|------|-------------|
| `query` | string | Search query |
| `pages` | number | Pages to scrape (1–10, default 1) |

```json
{
  "query": "nodejs best practices",
  "organic": [
    {
      "title": "Node.js Best Practices",
      "url": "https://github.com/goldbergyoni/nodebestpractices",
      "snippet": "The largest Node.js best practices list...",
      "page": 1
    }
  ],
  "featuredSnippet": "...",
  "totalResults": 47,
  "pagesScraped": 5,
  "scrapedAt": "2026-06-16T10:00:00.000Z"
}
```

### `POST /search/batch`
| Field | Type | Description |
|-------|------|-------------|
| `queries` | string[] | Up to 20 queries |
| `pages` | number | Pages per query (1–10) |

```json
{ "results": [ ...SerpResult[] ] }
```

## Architecture

```
src/
├── index.ts      Hono HTTP server (routes)
├── scraper.ts    CDP session management, navigation, human-like behaviors
├── browser.ts    CDPSession class, tab helpers, input helpers
├── parser.ts     Cheerio HTML parser (Google SERP selectors)
└── stealth.ts    Anti-detection JS injected before page scripts

test/
├── keywords.ts   100 keywords (English / Vietnamese / Japanese)
└── stress.ts     Stress test: 100 keywords × N pages with pacing
```

### How it works

1. On first request, opens a Chrome tab via `PUT /json/new` and connects via WebSocket
2. Injects stealth JS via `Page.addScriptToEvaluateOnNewDocument`
3. Sets geolocation to match public IP via `Emulation.setGeolocationOverride` + `Browser.grantPermissions`
4. Navigates to `google.com/search?q=...&hl=en&gl=us` and waits for `Page.loadEventFired`
5. For subsequent queries: clicks the search input (visual), then navigates via URL
6. Between searches (40% chance): visits a random developer site (GitHub, MDN, HN, etc.)
7. After page 1 (35% chance): clicks through to a top-3 organic result, dwells, returns
8. Tab is never closed — session cookie and history persist across queries

### CAPTCHA handling

When Google redirects to `/sorry/`, the scraper:
- Detects the URL after each navigation
- Closes and resets the session (fresh tab on next request)
- Throws `CaptchaError` which returns HTTP 500 with `{ "error": "CAPTCHA detected at: ..." }`

The stress test catches `CaptchaError` and pauses 3 minutes before continuing.

## Stress Test

```bash
# Against local Docker
npx tsx test/stress.ts

# Against remote
API_URL=http://your-server:3000 npx tsx test/stress.ts
```

Pacing: 5–15s between keywords, 30–60s between groups of 10, 3-minute pause on CAPTCHA.

## Docker

```yaml
# docker-compose.yml
services:
  serp-scraper:
    build: .
    ports:
      - "3000:3000"   # API
      - "6080:6080"   # noVNC
    shm_size: "2gb"   # required for Chrome
```

The container runs as the non-root `node` user so Chrome doesn't need `--no-sandbox`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `CHROME_DEBUG_URL` | `http://localhost:9222` | Chrome DevTools endpoint |

## Tech Stack

- **Runtime**: Node.js 20, TypeScript via `tsx`
- **HTTP**: [Hono](https://hono.dev) + `@hono/node-server`
- **Browser**: Google Chrome (real, headed), controlled via raw CDP WebSocket
- **Parsing**: [Cheerio](https://cheerio.js.org)
- **Display**: Xvfb + x11vnc + noVNC
- **Fonts**: `fonts-noto`, `fonts-noto-cjk` (Vietnamese + Japanese support)
