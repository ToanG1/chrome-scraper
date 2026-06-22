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

// Full organic MEO flow — no parameterized URLs, 100% human-like actions:
//   1. CDP navigate to google.co.jp homepage (no params, safe)
//   2. xdotool type keyword in omnibox → plain SERP (isTrusted=true, normal autocomplete)
//   3. xdotool click the Maps/Local tab → MEO results
// Subsequent keywords for the same location use searchInBox() instead.
export async function fetchMeoOrganic(query: string): Promise<string> {
  const session = await getSession();

  // Land on google.co.jp so the omnibox search defaults to the right domain
  await navigateAndWait(session, "https://www.google.co.jp");
  await sleep(rand(600, 1200));

  // Organic omnibox search — plain keyword, completely normal autocomplete telemetry
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
