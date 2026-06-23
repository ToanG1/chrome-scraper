import {
  openTab,
  closeTab,
  connectTab,
  openTabWithProxy,
  disposeBrowserContext,
  CDPSession,
  getElementRect,
} from "./browser";
import { STEALTH_JS } from "./stealth";
import { parseSerp, OrganicResult } from "./parser";
import { xdoNavigate, xdoOmniboxSearch, xdoScroll, xdoClick, xdoReplaceText, xdoKey } from "./xdotool";

const GOOGLE_URL = (q: string, start = 0): string =>
  `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us${start ? `&start=${start}` : ""}`;

// Sites a developer/researcher would plausibly visit between searches
const BROWSE_SITES = [
  "https://stackoverflow.com",
  "https://github.com",
  "https://news.ycombinator.com",
  "https://developer.mozilla.org",
  "https://www.wikipedia.org",
  "https://medium.com",
  "https://dev.to",
  "https://css-tricks.com",
  "https://www.reddit.com/r/programming",
  "https://smashingmagazine.com",
];

export interface SerpResult {
  query: string;
  organic: OrganicResult[];
  featuredSnippet: string | null;
  totalResults: number;
  pagesScraped: number;
  scrapedAt: string;
}

export class CaptchaError extends Error {
  constructor(url: string) {
    super(`CAPTCHA detected at: ${url}`);
    this.name = "CaptchaError";
  }
}

// ── Persistent session ────────────────────────────────────────────────────────

let _session: CDPSession | null = null;
let _tabId: string | null = null;
let _isFirstSearch = true;
let _captchaHit = false;
let _lastRealRequest = 0;

// Minimum quiet time before idle browsing is allowed to run (ms)
const IDLE_COOLDOWN = 90_000;

// ── Idle tab management ───────────────────────────────────────────────────────

interface IdleTab {
  id: string;
  session: CDPSession;
  homeUrl: string;
  label: string;
}

let _idleTabs: IdleTab[] = [];

// One persistent tab per activity — opened at startup and kept alive.
// Interaction happens within these tabs; the real-request tab is completely separate.
const IDLE_TAB_CONFIGS = [
  { homeUrl: "https://www.google.co.jp/maps", label: "maps"          },
  { homeUrl: "https://www.google.co.jp",      label: "search-food"   },
  { homeUrl: "https://www.google.co.jp",      label: "search-beauty" },
  { homeUrl: "https://www.google.co.jp",      label: "search-local"  },
  { homeUrl: "https://www.google.co.jp",      label: "search-news"   },
];

// Maps tab: rotate search queries to build Maps-specific history
const MAPS_QUERIES = [
  "東京 ラーメン", "渋谷 カフェ", "新宿 居酒屋", "大阪 寿司",
  "京都 観光スポット", "横浜 ホテル", "銀座 レストラン", "池袋 美容院",
  "浅草 観光", "名古屋 ランチ", "福岡 ラーメン", "札幌 カニ料理",
];

// Per-tab search query pools — each tab searches within its theme
const IDLE_SEARCH_QUERIES: Record<string, string[]> = {
  "search-food": [
    "ラーメン 東京", "カフェ 渋谷", "寿司 大阪", "居酒屋 新宿",
    "ランチ 銀座", "焼肉 池袋", "ラーメン おすすめ 東京",
    "カフェ おしゃれ 東京", "パスタ 渋谷", "ランチ 安い 新宿",
  ],
  "search-beauty": [
    "美容院 渋谷", "ネイルサロン 新宿", "エステ 銀座",
    "ヘアサロン 東京 おすすめ", "美容室 安い 渋谷",
    "まつげエクステ 新宿", "メンズカット 渋谷", "縮毛矯正 東京",
  ],
  "search-local": [
    "ホテル 京都", "観光スポット 大阪", "温泉 箱根",
    "旅館 京都 おすすめ", "ビジネスホテル 東京 安い",
    "観光 東京 おすすめ", "日帰り温泉 東京 近く", "ホテル 大阪 安い",
  ],
  "search-news": [
    "今日のニュース", "天気予報 東京", "スポーツニュース",
    "経済ニュース 日本", "テクノロジー ニュース", "芸能ニュース",
    "東京 イベント 今週", "映画 上映中 東京",
  ],
};

async function getSession(): Promise<CDPSession> {
  if (_session?.isConnected()) return _session;

  if (_tabId) closeTab(_tabId).catch(() => {});
  _session = null;
  _isFirstSearch = true;

  const tab = await openTab();
  _tabId = tab.id;
  _session = await connectTab(tab.webSocketDebuggerUrl);

  await _session.send("Page.enable");
  await _session.send("Network.enable");

  // Full CAPTCHA recovery — replicates `docker compose down && up` (wipes /tmp/chrome-profile).
  // Cookies + cache alone are not enough; Google also uses localStorage/IndexedDB.
  if (_captchaHit) {
    await _session.send("Network.clearBrowserCookies");
    await _session.send("Network.clearBrowserCache");
    for (const origin of ["https://www.google.com", "https://www.google.co.jp"]) {
      await _session.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "all",
      }).catch(() => {});
    }
    _captchaHit = false;
    console.log("[captcha] cleared cookies + cache + storage — fresh profile");
  }

  await _session.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_JS });

  const loc = await fetchIpLocation();
  await _session.send("Emulation.setGeolocationOverride", {
    latitude: loc.latitude,
    longitude: loc.longitude,
    accuracy: 100,
  });
  await _session.send("Browser.grantPermissions", {
    permissions: ["geolocation"],
    origin: "https://www.google.com",
  });

  return _session;
}

// Fetch any URL and return raw HTML.
// warmUpQuery: type a keyword in the Google search box first before navigating to the
// parameterized URL. Direct navigation to complex SERP URLs (sll=, fll=, udm=1, rflfq=1…)
// triggers CAPTCHA immediately — a human would search first then switch to Maps view.
export async function fetchUrl(url: string, proxy?: string, warmUpQuery?: string): Promise<string> {
  if (proxy) return fetchUrlWithProxy(url, proxy);
  _lastRealRequest = Date.now();
  const session = await getSession();

  if (warmUpQuery && _isFirstSearch) {
    // Only warm up once per session — do a plain search before the first complex URL.
    await humanSearch(session, warmUpQuery);
    await assertNoCaptcha(session);
    _isFirstSearch = false;
  } else if (_isFirstSearch) {
    _isFirstSearch = false;
  } else {
    await xdoClick(rand(200, 600), rand(200, 500));
    await sleep(rand(300, 700));
  }

  await navigateAndWait(session, url);
  await sleep(rand(800, 1500));
  await assertNoCaptcha(session);
  await scrollPage();
  await sleep(rand(400, 800));
  return getPageHtml(session);
}

// Mimic omnibox search: land on google.com homepage first so the subsequent
// search request carries Referer: https://www.google.com — same as a real user.
// sourceid=chrome&ie=UTF-8 match what Chrome appends on an omnibox search.
async function humanSearch(session: CDPSession, query: string): Promise<void> {
  await navigateAndWait(session, "https://www.google.com");
  await sleep(rand(800, 1500));
  await navigateAndWait(session, `https://www.google.com/search?q=${encodeURIComponent(query)}&sourceid=chrome&ie=UTF-8`);
  await sleep(rand(800, 1500));
  await scrollPage();
  await sleep(rand(500, 1000));
}

async function fetchUrlWithProxy(url: string, proxy: string): Promise<string> {
  const { tab, contextId } = await openTabWithProxy(proxy);
  const session = await connectTab(tab.webSocketDebuggerUrl);
  try {
    await session.send("Page.enable");
    await session.send("Network.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_JS });
    // Use CDP navigation for proxy tab — xdotool targets the focused window and
    // cannot address a background browser context.
    const load = session.waitForEvent("Page.loadEventFired", 15000);
    await session.send("Page.navigate", { url });
    await load.catch(() => {});
    await sleep(rand(800, 1500));
    await assertNoCaptcha(session);
    await scrollPage();
    await sleep(rand(400, 800));
    return await getPageHtml(session);
  } finally {
    session.close();
    await closeTab(tab.id).catch(() => {});
    await disposeBrowserContext(contextId);
  }
}

// Encode lat/lon into Google's uule query parameter.
// Binary: protobuf field-1 tag (0x0a) + varint length + UTF-8 "lat,lon" string.
function encodeUule(lat: number, lon: number): string {
  const loc = `${lat},${lon}`;
  const locBuf = Buffer.from(loc, "utf8");
  const binary = Buffer.concat([Buffer.from([0x0a, locBuf.length]), locBuf]);
  return "w+CAIQICIm" + binary.toString("base64");
}

// Full organic MEO flow with optional explicit location:
//   - If lat/lon provided: first try a direct uule URL to lock the session's location.
//     Google Maps uses that pinned location for the local pack.
//     If uule triggers CAPTCHA the tab is dropped (cookies preserved) and we fall back
//     to the organic omnibox path below.
//   - Organic path: google.co.jp homepage → omnibox keyword → Maps tab click.
//     With geolocation override set to target coords, Maps shows results for that city.
// Subsequent keywords for the same location use searchInBox() — session keeps location.
export async function fetchMeoOrganic(query: string, lat?: number, lon?: number): Promise<string> {
  _lastRealRequest = Date.now();

  // --- Attempt 1: uule URL (only when target location is specified) ---
  if (lat !== undefined && lon !== undefined) {
    const sessUule = await getSession();
    await sessUule.send("Emulation.setGeolocationOverride", {
      latitude: lat, longitude: lon, accuracy: 100,
    });

    const uule = encodeUule(lat, lon);
    const uuleUrl =
      `https://www.google.co.jp/search?q=${encodeURIComponent(query)}` +
      `&udm=1&uule=${encodeURIComponent(uule)}&hl=ja`;
    await navigateAndWait(sessUule, uuleUrl);
    await sleep(rand(1000, 1800));

    const currentUrl = await getCurrentUrl(sessUule);
    if (!currentUrl.includes("/sorry/")) {
      console.log("[meo-organic] uule succeeded");
      await scrollPage();
      await sleep(rand(400, 800));
      _isFirstSearch = false;
      return getPageHtml(sessUule);
    }

    // Soft CAPTCHA on the uule URL — drop the tab without clearing cookies,
    // so the profile's NID trust is preserved for the organic fallback.
    console.log("[meo-organic] uule CAPTCHA — falling back to organic omnibox");
    await closeSession();
  }

  // --- Attempt 2 (or only path when no lat/lon): organic omnibox ---
  const session = await getSession();

  if (lat !== undefined && lon !== undefined) {
    await session.send("Emulation.setGeolocationOverride", {
      latitude: lat, longitude: lon, accuracy: 100,
    });
  }

  await navigateAndWait(session, "https://www.google.co.jp");
  await sleep(rand(600, 1200));

  const load1 = session.waitForEvent("Page.loadEventFired", 15000);
  await xdoOmniboxSearch(query);
  await load1.catch(() => {});
  await sleep(rand(1000, 1800));
  await assertNoCaptcha(session);

  // Click the Maps / Local results tab (udm=1 link in the tab bar)
  const mapsTab = await getElementRect(session, 'a[href*="udm=1"]');
  if (mapsTab) {
    const load2 = session.waitForEvent("Page.loadEventFired", 15000);
    await xdoClick(mapsTab.cx, mapsTab.cy);
    await load2.catch(() => {});
    await sleep(rand(800, 1500));
    await assertNoCaptcha(session);
  }

  await scrollPage();
  await sleep(rand(400, 800));
  _isFirstSearch = false;
  return getPageHtml(session);
}

// Search for a new keyword from the current SERP page's search box.
// Google keeps the location context (uule/sll) in the session after the first
// MEO URL loads, so subsequent keywords stay pinned to the same area.
export async function searchInBox(query: string): Promise<string> {
  _lastRealRequest = Date.now();
  const session = await getSession();
  const inputRect = await getElementRect(session, 'textarea[name="q"], input[name="q"]');
  if (!inputRect) throw new Error("Search input not found — navigate to a SERP first");

  const load = session.waitForEvent("Page.loadEventFired", 15000);
  await xdoClick(inputRect.cx, inputRect.cy);
  await sleep(rand(300, 600));
  await xdoReplaceText(query);
  await sleep(rand(300, 500));
  await xdoKey("Return");
  await load.catch(() => {});
  await sleep(rand(800, 1500));
  await assertNoCaptcha(session);
  await scrollPage();
  await sleep(rand(400, 800));
  return getPageHtml(session);
}

// Opens all idle tabs at startup and loads their initial pages.
// These tabs stay alive permanently; idleBrowse() interacts within them.
// Completely separate from the real-request tab — no race condition possible.
export async function initIdleTabs(): Promise<void> {
  for (const config of IDLE_TAB_CONFIGS) {
    try {
      const tab = await openTab();
      const session = await connectTab(tab.webSocketDebuggerUrl);
      await session.send("Page.enable");
      await session.send("Network.enable");
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_JS });
      const load = session.waitForEvent("Page.loadEventFired", 15000);
      await session.send("Page.navigate", { url: config.homeUrl });
      await load.catch(() => {});
      await sleep(rand(1500, 3000));
      _idleTabs.push({ id: tab.id, session, homeUrl: config.homeUrl, label: config.label });
      console.log(`[idle-tab] ready: ${config.label}`);
    } catch (e) {
      console.warn(`[idle-tab] failed to open ${config.label}:`, (e as Error).message);
    }
  }
  console.log(`[idle-tab] ${_idleTabs.length}/${IDLE_TAB_CONFIGS.length} tabs ready`);
}

// Called by the idle loop. Picks a random idle tab and interacts within it.
// Skips silently if a real request ran recently.
export async function idleBrowse(): Promise<void> {
  if (Date.now() - _lastRealRequest < IDLE_COOLDOWN) return;
  if (_idleTabs.length === 0) return;

  const tab = _idleTabs[Math.floor(Math.random() * _idleTabs.length)];
  console.log(`[idle] ${tab.label}`);
  try {
    await interactWithIdleTab(tab);
  } catch (e) {
    console.warn(`[idle] ${tab.label} error (recovering):`, (e as Error).message);
    // Navigate back to home so the tab stays usable next cycle
    tab.session.send("Page.navigate", { url: tab.homeUrl }).catch(() => {});
  }
}

// Interacts with an already-open idle tab.
// Uses Runtime.evaluate for click/scroll — works on any tab regardless of focus.
// isTrusted=false is acceptable here; we only need the HTTP request history, not bot bypass.
async function interactWithIdleTab(tab: IdleTab): Promise<void> {
  const s = tab.session;

  if (tab.label === "maps") {
    await interactMapsTab(s);
  } else {
    await interactSearchTab(s, tab.label);
  }
}

// Open a URL in a fresh temporary tab, browse it (scroll + maybe an internal click),
// then close the tab. Simulates a user opening a search result in a new tab.
async function browseUrlInNewTab(url: string): Promise<void> {
  let tab: { id: string; webSocketDebuggerUrl: string } | null = null;
  try {
    tab = await openTab();
    const s = await connectTab(tab.webSocketDebuggerUrl);
    await s.send("Page.enable");
    await s.send("Network.enable");
    await s.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_JS });
    const load = s.waitForEvent("Page.loadEventFired", 15000);
    await s.send("Page.navigate", { url });
    await load.catch(() => {});
    await sleep(rand(2000, 4000));
    await cdpScroll(s);
    await sleep(rand(1500, 3000));
    await cdpScroll(s);
    await sleep(rand(1000, 2500));
    // ~40%: click one same-domain link to simulate deeper browsing
    if (Math.random() < 0.4) {
      await s.send("Runtime.evaluate", {
        expression: `(function() {
          const host = location.hostname;
          const links = Array.from(document.querySelectorAll('a[href]')).filter(a => {
            try {
              const u = new URL(a.href);
              const r = a.getBoundingClientRect();
              return u.hostname === host && u.pathname !== location.pathname
                && r.width > 0 && r.height > 0 && r.top > 60 && r.top < window.innerHeight - 60;
            } catch { return false; }
          });
          if (links.length) links[Math.floor(Math.random() * Math.min(links.length, 5))].click();
        })()`,
        awaitPromise: false,
      });
      await sleep(rand(4000, 8000));
      await cdpScroll(s);
      await sleep(rand(2000, 4000));
    }
    s.close();
  } finally {
    if (tab) closeTab(tab.id).catch(() => {});
  }
}

// Google Maps tab — search for a local query, scroll, open a place detail in a new tab
async function interactMapsTab(s: CDPSession): Promise<void> {
  const q = MAPS_QUERIES[Math.floor(Math.random() * MAPS_QUERIES.length)];
  const load = s.waitForEvent("Page.loadEventFired", 12000);
  await s.send("Page.navigate", {
    url: `https://www.google.co.jp/maps/search/${encodeURIComponent(q)}`,
  });
  await load.catch(() => {});
  await sleep(rand(2000, 4000));
  await cdpScroll(s);
  await sleep(rand(1500, 3000));

  // Extract a place URL then open it in a new tab (~60%)
  if (Math.random() < 0.6) {
    const res = await s.send("Runtime.evaluate", {
      expression: `(function() {
        const a = document.querySelector('a[href*="/maps/place/"]');
        return a ? a.href : null;
      })()`,
      returnByValue: true,
    }) as { result?: { value?: string | null } };
    const placeUrl = res?.result?.value;
    if (placeUrl) {
      console.log(`[idle] maps → new tab: ${placeUrl.slice(0, 60)}…`);
      await browseUrlInNewTab(placeUrl);
    }
  }
}

// Search tabs — organic Google SERP, scroll results, open 1-2 result URLs in new tabs.
// The idle tab stays at the SERP; the new tabs do the dwell-time browsing.
async function interactSearchTab(s: CDPSession, label: string): Promise<void> {
  const pool = IDLE_SEARCH_QUERIES[label] ?? IDLE_SEARCH_QUERIES["search-food"];
  const q    = pool[Math.floor(Math.random() * pool.length)];

  // Navigate to Google SERP
  const load1 = s.waitForEvent("Page.loadEventFired", 15000);
  await s.send("Page.navigate", {
    url: `https://www.google.co.jp/search?q=${encodeURIComponent(q)}&hl=ja&gl=jp`,
  });
  await load1.catch(() => {});
  await sleep(rand(1500, 3000));
  await cdpScroll(s);
  await sleep(rand(1000, 2500));

  // Extract organic result URLs (skip Google-owned domains)
  const urlsRes = await s.send("Runtime.evaluate", {
    expression: `(function() {
      return Array.from(document.querySelectorAll('h3'))
        .filter(h => h.closest('a[href]'))
        .map(h => h.closest('a[href]').href)
        .filter(u => {
          try {
            const host = new URL(u).hostname;
            return !host.includes('google') && u.startsWith('http');
          } catch { return false; }
        })
        .slice(0, 5);
    })()`,
    returnByValue: true,
  }) as { result?: { value?: string[] } };
  const urls = urlsRes?.result?.value ?? [];

  if (urls.length === 0) return;

  // Open the first result in a new tab (CTR signal)
  console.log(`[idle] ${label} → new tab: ${urls[0].slice(0, 60)}…`);
  await browseUrlInNewTab(urls[0]);

  // ~30%: open a second result to look like a comparison session
  if (urls.length > 1 && Math.random() < 0.3) {
    await sleep(rand(3000, 6000));
    console.log(`[idle] ${label} → new tab #2: ${urls[1].slice(0, 60)}…`);
    await browseUrlInNewTab(urls[1]);
  }
}

// CDP-based smooth scroll — no xdotool needed, works on background tabs
async function cdpScroll(s: CDPSession): Promise<void> {
  await s.send("Runtime.evaluate", {
    expression: `window.scrollBy({ top: ${rand(250, 550)}, behavior: 'smooth' })`,
    awaitPromise: false,
  });
  await sleep(rand(800, 1500));
  await s.send("Runtime.evaluate", {
    expression: `window.scrollBy({ top: ${rand(100, 300)}, behavior: 'smooth' })`,
    awaitPromise: false,
  });
}

export async function closeSession(): Promise<void> {
  if (_session) { _session.close(); _session = null; }
  if (_tabId) { await closeTab(_tabId); _tabId = null; }
  _isFirstSearch = true;
  // _captchaHit is intentionally NOT reset here — it must survive until the next getSession()
}

// ── CAPTCHA detection ─────────────────────────────────────────────────────────

async function getCurrentUrl(session: CDPSession): Promise<string> {
  const result = (await session.send("Runtime.evaluate", {
    expression: "document.location.href",
    returnByValue: true,
  })) as { result?: { value?: string } };
  return result?.result?.value ?? "";
}

async function assertNoCaptcha(session: CDPSession): Promise<void> {
  const url = await getCurrentUrl(session);
  if (url.includes("/sorry/") || url.includes("google.com/sorry")) {
    _captchaHit = true;
    await closeSession();
    throw new CaptchaError(url);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function navigateAndWait(session: CDPSession, url: string): Promise<void> {
  const load = session.waitForEvent("Page.loadEventFired", 15000);
  await session.send("Page.navigate", { url });
  await load.catch(() => {});
}

async function getPageHtml(session: CDPSession): Promise<string> {
  const result = (await session.send("Runtime.evaluate", {
    expression: "document.documentElement.outerHTML",
    returnByValue: true,
  })) as { result?: { value?: string } };
  return result?.result?.value ?? "";
}

// ── Human-like behaviors ──────────────────────────────────────────────────────

async function scrollPage(): Promise<void> {
  await xdoScroll();
}

// Visit a random non-Google site to break up the SERP-only pattern
async function humanBrowse(session: CDPSession): Promise<void> {
  const site = BROWSE_SITES[Math.floor(Math.random() * BROWSE_SITES.length)];
  console.log(`[browse] visiting ${site}`);
  await navigateAndWait(session, site);
  await sleep(rand(3000, 7000));
  await scrollPage();
  await sleep(rand(1000, 3000));
}

// Click through to one of the top organic results, dwell, then come back to Google
async function clickResult(session: CDPSession, resultUrl: string, returnUrl: string): Promise<void> {
  console.log(`[click] visiting result: ${resultUrl.slice(0, 60)}...`);
  await navigateAndWait(session, resultUrl);
  await sleep(rand(4000, 9000));
  await scrollPage();
  await sleep(rand(1000, 3000));
  // navigate back to SERP so the tab history looks natural
  await navigateAndWait(session, returnUrl);
  await sleep(rand(800, 1500));
}

async function searchNext(session: CDPSession, query: string): Promise<void> {
  // ~40% chance to visit a random site before returning to Google
  if (Math.random() < 0.4) {
    await humanBrowse(session);
  }

  const inputRect = await getElementRect(session, 'input[name="q"]');
  if (inputRect) {
    await xdoClick(inputRect.cx, inputRect.cy);
    await sleep(rand(400, 800));
  }
  await navigateAndWait(session, GOOGLE_URL(query));
}

// ── Main scrape function ──────────────────────────────────────────────────────

export async function scrapeSerp(query: string, pages = 1): Promise<SerpResult> {
  const maxPages = Math.min(Math.max(1, Math.floor(pages)), 10);
  const session = await getSession();
  const allOrganic: OrganicResult[] = [];
  let featuredSnippet: string | null = null;

  if (_isFirstSearch) {
    await navigateAndWait(session, GOOGLE_URL(query));
    _isFirstSearch = false;
  } else {
    await searchNext(session, query);
  }
  await sleep(rand(800, 1800));
  await assertNoCaptcha(session);

  // Scroll through results naturally before scraping
  await scrollPage();
  await sleep(rand(500, 1000));

  const serpUrl1 = GOOGLE_URL(query);
  const html1 = await getPageHtml(session);
  const p1 = parseSerp(html1, query);
  allOrganic.push(...p1.organic.map((r) => ({ ...r, page: 1 })));
  if (p1.featuredSnippet) featuredSnippet = p1.featuredSnippet;

  // ~35% chance to click through to one of the top 3 results
  if (p1.organic.length > 0 && Math.random() < 0.35) {
    const pick = p1.organic[Math.floor(Math.random() * Math.min(3, p1.organic.length))];
    await clickResult(session, pick.url, serpUrl1);
    await assertNoCaptcha(session);
  }

  for (let page = 2; page <= maxPages; page++) {
    await navigateAndWait(session, GOOGLE_URL(query, (page - 1) * 10));
    await sleep(rand(600, 1400));
    await assertNoCaptcha(session);

    await scrollPage();
    await sleep(rand(400, 800));

    const html = await getPageHtml(session);
    const pN = parseSerp(html, query);
    allOrganic.push(...pN.organic.map((r) => ({ ...r, page })));
    if (!featuredSnippet && pN.featuredSnippet) featuredSnippet = pN.featuredSnippet;
  }

  return {
    query,
    organic: allOrganic,
    featuredSnippet,
    totalResults: allOrganic.length,
    pagesScraped: maxPages,
    scrapedAt: new Date().toISOString(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

async function fetchIpLocation(): Promise<{ latitude: number; longitude: number }> {
  try {
    const res = await fetch("http://ip-api.com/json?fields=status,lat,lon", { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { status: string; lat: number; lon: number };
    if (data.status === "success") {
      console.log(`[geo] resolved location: ${data.lat}, ${data.lon}`);
      return { latitude: data.lat, longitude: data.lon };
    }
  } catch (e) {
    console.warn("[geo] ip-api failed, using default:", (e as Error).message);
  }
  return { latitude: 35.6762, longitude: 139.6503 };
}
