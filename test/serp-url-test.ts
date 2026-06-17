/**
 * MEO + SEO SERP URL test
 *
 * MEO: Maps/local results  — udm=1, rflfq=1, rldoc=1
 * SEO: Organic results     — num=100, brd_scroll=1
 *
 * Run: npx tsx test/serp-url-test.ts
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";

// ── URL builders ──────────────────────────────────────────────────────────────
// uule=lat,lon works when the Chrome instance is behind a Japanese IP.
// Without a JP proxy Google ignores the coordinates and falls back to IP geolocation.

// MEO: sll/fll are the "Search this area" parameters Google adds when you click that button.
// They work without matching IP — unlike raw uule=lat,lon which requires IP to match.
// span: ~4km radius around the store; zoom 14 matches typical Maps detail level.
function meoUrl(query: string, lat: number, lon: number, hl = "ja", gl = "jp"): string {
  const span = "0.04,0.065";
  return (
    `https://www.google.com/search?q=${encodeURIComponent(query)}` +
    `&hl=${hl}&gl=${gl}&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1` +
    `&fll=${lat},${lon}&fspn=${span}&fz=14` +
    `&sll=${lat},${lon}&sspn=${span}&sz=14&stq=1&cs=0`
  );
}

function seoUrl(query: string, lat: number, lon: number, hl = "ja", gl = "jp"): string {
  return (
    `https://www.google.com/search?q=${encodeURIComponent(query)}` +
    `&hl=${hl}&gl=${gl}&num=100&brd_scroll=1&pws=0&ie=UTF-8&oe=UTF-8` +
    `&sll=${lat},${lon}`
  );
}

// ── Locations ─────────────────────────────────────────────────────────────────

// Coordinates are taken from the client's store location (same as Bright Data usage).
// These work correctly when Chrome is behind a Japanese IP (set PROXY_SERVER env var).
const LOCATIONS: { name: string; lat: number; lon: number }[] = [
  { name: "Tokyo",    lat: 35.6762,  lon: 139.6503  },
  { name: "Osaka",    lat: 34.6937,  lon: 135.5023  },
  { name: "Kyoto",    lat: 35.0116,  lon: 135.7681  },
  { name: "Yokohama", lat: 35.4437,  lon: 139.6380  },
  { name: "Sapporo",  lat: 43.0621,  lon: 141.3544  },
];

// ── Keywords ──────────────────────────────────────────────────────────────────

const KEYWORDS = [
  "sushi",
  "ramen",
  "tempura",
  "居酒屋",       // izakaya
  "ラーメン店",   // ramen shop
  "カフェ",       // cafe
  "ホテル",       // hotel
  "観光スポット", // tourist spots
  "美容院",       // hair salon
  "歯医者",       // dentist
];

// ── Test cases ────────────────────────────────────────────────────────────────

interface TestCase {
  type: "MEO" | "SEO";
  keyword: string;
  location: string;
  url: string;
}

const cases: TestCase[] = [];
for (const loc of LOCATIONS) {
  for (const kw of KEYWORDS) {
    cases.push({ type: "MEO", keyword: kw, location: loc.name, url: meoUrl(kw, loc.lat, loc.lon) });
    cases.push({ type: "SEO", keyword: kw, location: loc.name, url: seoUrl(kw, loc.lat, loc.lon) });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand  = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function htmlStats(html: string): { bytes: number; hasMeoResults: boolean; hasSeoResults: boolean } {
  return {
    bytes: html.length,
    hasMeoResults: html.includes("hqp_pb") || html.includes("rllt__") || html.includes("data-cid"),
    hasSeoResults: html.includes("data-snc") || html.includes("LC20lb"),
  };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(`${API_URL}/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.text();
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log(`SERP URL test — ${cases.length} requests (${LOCATIONS.length} locations × ${KEYWORDS.length} keywords × 2 types)`);
  log(`API: ${API_URL}`);

  const results: {
    type: string; keyword: string; location: string;
    ok: boolean; captcha: boolean; bytes: number;
    hasMeo: boolean; hasSeo: boolean; elapsed: number; error?: string;
  }[] = [];

  for (let i = 0; i < cases.length; i++) {
    const { type, keyword, location, url } = cases[i];
    const t0 = Date.now();

    log(`[${i + 1}/${cases.length}] ${type} "${keyword}" @ ${location}`);

    try {
      const html = await fetchHtml(url);
      const elapsed = Date.now() - t0;
      const stats = htmlStats(html);
      results.push({ type, keyword, location, ok: true, captcha: false, elapsed, ...{ bytes: stats.bytes, hasMeo: stats.hasMeoResults, hasSeo: stats.hasSeoResults } });
      log(`  OK  ${(stats.bytes / 1024).toFixed(0)}KB  meo=${stats.hasMeoResults}  seo=${stats.hasSeoResults}  ${fmt(elapsed)}`);
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = (err as Error).message;
      const isCaptcha = msg.toLowerCase().includes("captcha");
      results.push({ type, keyword, location, ok: false, captcha: isCaptcha, bytes: 0, hasMeo: false, hasSeo: false, elapsed, error: msg });
      if (isCaptcha) {
        log(`  CAPTCHA — pausing 3 minutes...`);
        await sleep(180000);
      } else {
        log(`  FAIL  ${msg}`);
      }
    }

    // Light pause: 5–12s between requests, 20–40s every 10 requests
    if (i < cases.length - 1) {
      const pause = (i + 1) % 10 === 0 ? rand(20000, 40000) : rand(5000, 12000);
      log(`  -> pause ${fmt(pause)}`);
      await sleep(pause);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const ok       = results.filter(r => r.ok);
  const failed   = results.filter(r => !r.ok && !r.captcha);
  const captchas = results.filter(r => r.captcha);

  const meoOk = ok.filter(r => r.type === "MEO");
  const seoOk = ok.filter(r => r.type === "SEO");
  const meoHit = meoOk.filter(r => r.hasMeo).length;
  const seoHit = seoOk.filter(r => r.hasSeo).length;
  const avgMs  = ok.length ? Math.round(ok.reduce((s, r) => s + r.elapsed, 0) / ok.length) : 0;

  console.log(`
╔════════════════════════════════════════════════╗
║          SERP URL TEST SUMMARY                 ║
╠════════════════════════════════════════════════╣
║  Total requests     : ${String(results.length).padEnd(24)}║
║  Succeeded          : ${String(ok.length).padEnd(24)}║
║  CAPTCHA hits       : ${String(captchas.length).padEnd(24)}║
║  Other failures     : ${String(failed.length).padEnd(24)}║
╠════════════════════════════════════════════════╣
║  MEO ok / w/ results: ${`${meoOk.length} / ${meoHit}`.padEnd(24)}║
║  SEO ok / w/ results: ${`${seoOk.length} / ${seoHit}`.padEnd(24)}║
║  Avg time/request   : ${fmt(avgMs).padEnd(24)}║
╚════════════════════════════════════════════════╝`);

  if (failed.length > 0) {
    console.log("\nFailures:");
    failed.forEach(r => console.log(`  [${r.type}] "${r.keyword}" @ ${r.location}: ${r.error}`));
  }

  // Per-location breakdown
  console.log("\nPer-location breakdown:");
  for (const loc of LOCATIONS) {
    const locOk = ok.filter((r) => r.location === loc.name);
    const locMeo = locOk.filter(r => r.type === "MEO" && r.hasMeo).length;
    const locSeo = locOk.filter(r => r.type === "SEO" && r.hasSeo).length;
    console.log(`  ${loc.name.padEnd(10)} MEO hits: ${locMeo}/${KEYWORDS.length}  SEO hits: ${locSeo}/${KEYWORDS.length}`);
  }
}

run().catch((err: Error) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
