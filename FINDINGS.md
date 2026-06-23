# Google SERP Scraper — CAPTCHA & Location Findings

## TL;DR

| Approach | Profile | CAPTCHA rate |
|---|---|---|
| Direct URL every request, no warmup | Fresh | Immediate (request 1) |
| Direct URL every request, warmed profile | 24h warmup | ~5 requests then CAPTCHA |
| **Hybrid: direct URL first per location, searchInBox after** | **24h warmup** | **0/50 (all pass)** |

The recommended production flow is the **hybrid approach**.

---

## 1. Profile Warmup

A cold Chrome profile (fresh Docker volume) is banned almost immediately on parameterized Google SERP URLs (`rflfq=1`, `rldoc=1`, `udm=1`, `uule=…`). Google treats these as bot-like because:

- No NID cookie — no session history
- No interaction signals (no searches, no clicks, no Maps use)
- No geolocation trust built up

**Solution: 24-hour idle warmup before production use.**

The warmup loop runs in the background at all times:
- 5 persistent tabs: Google Maps + 4 themed search tabs (food, beauty, local, news)
- Each cycle: organic Google search → extract result URLs → open in new tab → scroll → optionally follow a same-domain link → close tab
- Interval: 3–8 minutes between cycles, 90-second cooldown after any real request
- Result after 24h: ~1.5 GB profile, 1,200+ cookies across 344 domains, active NID on both `google.com` and `google.co.jp`

---

## 2. CAPTCHA Behavior by Approach

### Full direct URL every request

URL format tested:
```
https://www.google.co.jp/search?q=KEYWORD&hl=ja&gl=jp&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1&uule=LAT,LON
```

**Result (warmed profile, 12–20s pauses between requests):**

- Requests 1–5: OK, `meo=true`
- Request 6: CAPTCHA redirect to `google.com/sorry/index`
- After 5-minute pause + cookie clear: requests 7–10 OK
- Request 11 (first request after location change): CAPTCHA again

**Why:** Google's abuse detection triggers on the *volume* of parameterized URL requests from a single IP in a short timeframe (~5 requests / 90 seconds). Changing location coordinates doesn't help — the IP pattern itself is flagged.

After CAPTCHA, the session's cookies are cleared (NID trust reset), making subsequent requests even more fragile.

### Hybrid: direct URL for first keyword, searchInBox for the rest

**Result (warmed profile, 15–25s pauses, 50–80s every 10 requests):**

- 50/50 requests succeeded
- 0 CAPTCHA
- 49/50 `meo=true` (1 miss: keyword returned no local pack — not a CAPTCHA)
- All 5 cities correctly localized (Tokyo, Osaka, Kyoto, Yokohama, Sapporo)

**Why it works:** Only **one** direct URL per location group. The session absorbs the parameterized URL once, then subsequent keywords use the search box (normal human typing). Google sees: one URL navigation → several box searches. That pattern matches a real user.

---

## 3. Recommended Production Flow

### Single-call batch endpoint (recommended)

```
POST /fetch/meo-batch
{
  "lat": 35.6762,
  "lon": 139.6503,
  "keywords": ["sushi", "ramen", "居酒屋", "カフェ", "ホテル"],
  "html": false          // omit html bodies, return metadata only
}
```

Or with a custom URL template (full control over params):

```
POST /fetch/meo-batch
{
  "templateUrl": "https://www.google.co.jp/search?q={query}&hl=ja&gl=jp&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1&uule=35.6762,139.6503",
  "keywords": ["sushi", "ramen", "居酒屋"]
}
```

The `{query}` placeholder is replaced with `encodeURIComponent(keyword)` for the first keyword. Subsequent keywords use `searchInBox`. The server handles the hybrid flow automatically.

Response (one entry per keyword):
```json
[
  { "keyword": "sushi",  "method": "url", "ok": true, "bytes": 718000, "meo": true },
  { "keyword": "ramen",  "method": "box", "ok": true, "bytes": 718000, "meo": true },
  { "keyword": "居酒屋", "method": "box", "ok": true, "bytes": 718000, "meo": true }
]
```

Add `"html": true` (default) to receive full HTML in each entry for rank parsing.

### Manual multi-call flow (fine-grained control)

```
POST /fetch/meo              { query: "keyword1", lat: X, lon: Y }   ← direct URL, locks location
POST /fetch/search-in-box    { query: "keyword2" }                    ← box, keeps context
POST /fetch/search-in-box    { query: "keyword3" }
...
POST /fetch/meo              { query: "keyword1", lat: X2, lon: Y2 } ← new location
```

**Minimum pause between requests:** 15 seconds. Recommended 15–25 seconds.
**Longer break every ~10 requests:** 50–80 seconds (mimics tab switching / reading).
**Location switch pause:** 50–80 seconds before the next `/fetch/meo` call.

---

## 4. Location Accuracy

### Problem with IP-based geolocation

The Docker container IP resolves to Hanoi, Vietnam. Without explicit location params:
- `fetchMeoOrganic` (no lat/lon) → Google shows Maps results near **Hanoi**
- `meo=true` can still pass (Maps markers exist) but results are **wrong city**

### Solution: `uule=lat,lon` + `Emulation.setGeolocationOverride`

Two mechanisms work together:

1. **`uule=lat,lon` in the URL** — tells Google's search algorithm to show the Maps local pack for those coordinates. Works from any IP once the profile has NID trust.

2. **`Emulation.setGeolocationOverride`** — sets Chrome's Geolocation API to the target coordinates. Used when Google Maps JS asks `navigator.geolocation`. Set before every `/fetch/meo` call when coordinates change.

The plain `lat,lon` format (e.g. `uule=35.6762,139.6503`) works. Binary-encoded uule (`w+CAIQICIm…`) is not needed.

### Verifying correct localization

Check the per-location response size. Different cities return different-sized pages because the local pack contents differ:

| City | Typical response |
|---|---|
| Tokyo | ~670–720 KB |
| Osaka | ~710–720 KB |
| Sapporo | ~715–720 KB |

If the response is ~260 KB with `meo=false`, the location is not resolving and Google is returning a plain SERP — likely because the profile has insufficient trust for the given IP + coordinate combination.

---

## 5. CAPTCHA Recovery

When CAPTCHA is detected (`/sorry/index` in the URL):

1. Session closes, `_captchaHit = true`
2. Next `getSession()` clears: cookies, cache, localStorage, IndexedDB for `google.com` and `google.co.jp`
3. A new tab is opened with a clean in-memory state

**Cost:** NID and session trust reset. The on-disk profile is untouched (Chrome profile volume persists), but in-memory Google cookies are gone until rebuilt. Recovery takes 30–60 minutes of idle browsing.

**Prevention:** Always use the hybrid flow. Never send more than 1 direct URL per location group.

---

## 6. Stealth Configuration

Key Chrome flags and patches active in the container:

| Item | Setting |
|---|---|
| Chrome language | `--lang=ja` |
| WebGL vendor | `Intel Inc.` (ANGLE/D3D11 spoofed) |
| Canvas noise | 1-bit XOR noise on `toDataURL`/`toBlob` |
| `navigator.webdriver` | removed |
| `navigator.languages` | `['ja-JP', 'ja', 'en']` |
| `navigator.hardwareConcurrency` | 8 |
| `navigator.deviceMemory` | 8 |
| `navigator.plugins` | PDF Viewer entries |
| `permissions.query` | returns `'default'` for notifications |
| `window.chrome` | full object with `loadTimes`, `csi`, `app`, `runtime` |
| Geolocation | set to IP location at session start, overridden to target at request time |

---

## 7. Idle Browsing Strategy

To maintain NID trust continuously:

- **5 permanent idle tabs** opened at startup (Maps + 4 search themes)
- Each cycle picks a random tab and:
  - Maps tab: searches a Japanese local query, opens a place URL in a new tab
  - Search tabs: searches a themed Japanese keyword, opens 1–2 organic result URLs in new tabs
- New tabs browse the destination site (scroll, optional internal link click), then close
- **CTR during real requests:** every `/fetch/meo` and `/fetch/meo-organic` also opens the first linked business website in a background tab, fire-and-forget

This means Google sees continuous natural browsing even between real API calls, and every real API request produces an additional click signal.
