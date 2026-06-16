import {
  openTab,
  closeTab,
  connectTab,
  CDPSession,
  mouseClick,
  getElementRect,
} from "./browser";
import { STEALTH_JS } from "./stealth";
import { parseSerp, OrganicResult } from "./parser";

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

async function getSession(): Promise<CDPSession> {
  if (_session?.isConnected()) return _session;

  if (_tabId) closeTab(_tabId).catch(() => {});
  _session = null;
  _isFirstSearch = true;

  const tab = await openTab();
  _tabId = tab.id;
  _session = await connectTab(tab.webSocketDebuggerUrl);

  await _session.send("Page.enable");
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

export async function closeSession(): Promise<void> {
  if (_session) { _session.close(); _session = null; }
  if (_tabId) { await closeTab(_tabId); _tabId = null; }
  _isFirstSearch = true;
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

// Scroll down the page in a few natural steps
async function scrollPage(session: CDPSession): Promise<void> {
  const steps = rand(3, 6);
  for (let i = 0; i < steps; i++) {
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: rand(300, 800),
      y: rand(200, 500),
      deltaX: 0,
      deltaY: rand(200, 450),
    });
    await sleep(rand(300, 700));
  }
}

// Visit a random non-Google site to break up the SERP-only pattern
async function humanBrowse(session: CDPSession): Promise<void> {
  const site = BROWSE_SITES[Math.floor(Math.random() * BROWSE_SITES.length)];
  console.log(`[browse] visiting ${site}`);
  await navigateAndWait(session, site);
  await sleep(rand(3000, 7000));
  await scrollPage(session);
  await sleep(rand(1000, 3000));
}

// Click through to one of the top organic results, dwell, then come back to Google
async function clickResult(session: CDPSession, resultUrl: string, returnUrl: string): Promise<void> {
  console.log(`[click] visiting result: ${resultUrl.slice(0, 60)}...`);
  await navigateAndWait(session, resultUrl);
  await sleep(rand(4000, 9000));
  await scrollPage(session);
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
    await mouseClick(session, inputRect.cx, inputRect.cy);
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
  await scrollPage(session);
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

    await scrollPage(session);
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
