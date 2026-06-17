/**
 * MEO + SEO SERP URL test
 *
 * MEO: Maps/local results  — udm=1, rflfq=1, rldoc=1
 * SEO: Organic results     — num=100, brd_scroll=1
 *
 * Run: npx tsx test/serp-url-test.ts
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";

// ── uule encoder ──────────────────────────────────────────────────────────────
// Google's uule parameter encodes a location name as:
//   "w+CAIQICI" + base64( byte(utf8_length) + utf8_bytes )
// Raw lat,lon strings are silently ignored by Google → "location unknown".

function encodeUule(locationName: string): string {
  const buf = Buffer.from(locationName, "utf-8");
  const withLen = Buffer.concat([Buffer.from([buf.length]), buf]);
  return "w+CAIQICI" + withLen.toString("base64");
}

// ── URL builders ──────────────────────────────────────────────────────────────

function meoUrl(query: string, location: string, hl = "ja", gl = "jp"): string {
  return (
    `http://www.google.co.jp/search?q=${encodeURIComponent(query)}` +
    `&hl=${hl}&gl=${gl}&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1` +
    `&uule=${encodeURIComponent(encodeUule(location))}`
  );
}

function seoUrl(query: string, location: string, hl = "ja", gl = "jp"): string {
  return (
    `http://www.google.co.jp/search?q=${encodeURIComponent(query)}` +
    `&hl=${hl}&gl=${gl}&num=100&brd_scroll=1&pws=0&ie=UTF-8&oe=UTF-8` +
    `&uule=${encodeURIComponent(encodeUule(location))}`
  );
}

// ── Locations ─────────────────────────────────────────────────────────────────

// Location names passed directly to encodeUule — use the name Google Maps knows
const LOCATIONS: { name: string; uule: string }[] = [
  { name: "Tokyo",    uule: "Tokyo, Japan" },
  { name: "Osaka",    uule: "Osaka, Japan" },
  { name: "Kyoto",    uule: "Kyoto, Japan" },
  { name: "Yokohama", uule: "Yokohama, Japan" },
  { name: "Sapporo",  uule: "Sapporo, Japan" },
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
    cases.push({ type: "MEO", keyword: kw, location: loc.name, url: meoUrl(kw, loc.uule) });
    cases.push({ type: "SEO", keyword: kw, location: loc.name, url: seoUrl(kw, loc.uule) });
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
