/**
 * MEO SERP URL stress test
 *
 * URL format matches production usage:
 *   google.co.jp + uule=lat,lon + udm=1/rflfq=1/rldoc=1 (Maps local results)
 *
 * Run: npx tsx test/serp-url-test.ts
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";

// ── URL builder ───────────────────────────────────────────────────────────────

function meoUrl(query: string, lat: number, lon: number): string {
  return (
    `http://www.google.co.jp/search?q=${encodeURIComponent(query)}` +
    `&hl=ja&gl=jp&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1` +
    `&uule=${lat},${lon}`
  );
}

// ── Locations ─────────────────────────────────────────────────────────────────

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
  keyword: string;
  location: string;
  url: string;
}

const cases: TestCase[] = [];
for (const loc of LOCATIONS) {
  for (const kw of KEYWORDS) {
    cases.push({ keyword: kw, location: loc.name, url: meoUrl(kw, loc.lat, loc.lon) });
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

function htmlStats(html: string): { bytes: number; hasMeo: boolean } {
  return {
    bytes: html.length,
    hasMeo: html.includes("rllt__") || html.includes("hqp_pb") || html.includes("data-cid"),
  };
}

async function fetchHtml(url: string, warmUpQuery: string): Promise<string> {
  const res = await fetch(`${API_URL}/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, warmUpQuery }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.text();
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log(`MEO stress test — ${cases.length} requests (${LOCATIONS.length} locations × ${KEYWORDS.length} keywords)`);
  log(`API: ${API_URL}`);

  const results: {
    keyword: string; location: string;
    ok: boolean; captcha: boolean; bytes: number;
    hasMeo: boolean; elapsed: number; error?: string;
  }[] = [];

  for (let i = 0; i < cases.length; i++) {
    const { keyword, location, url } = cases[i];
    const t0 = Date.now();

    log(`[${i + 1}/${cases.length}] "${keyword}" @ ${location}`);

    try {
      const html = await fetchHtml(url, keyword);
      const elapsed = Date.now() - t0;
      const stats = htmlStats(html);
      results.push({ keyword, location, ok: true, captcha: false, elapsed, bytes: stats.bytes, hasMeo: stats.hasMeo });
      log(`  OK  ${(stats.bytes / 1024).toFixed(0)}KB  meo=${stats.hasMeo}  ${fmt(elapsed)}`);
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = (err as Error).message;
      const isCaptcha = msg.toLowerCase().includes("captcha");
      results.push({ keyword, location, ok: false, captcha: isCaptcha, bytes: 0, hasMeo: false, elapsed, error: msg });
      if (isCaptcha) {
        log(`  CAPTCHA — pausing 5 minutes...`);
        await sleep(300000);
      } else {
        log(`  FAIL  ${msg}`);
      }
    }

    // Slow pace: 15–25s between requests, 50–80s break every 10 requests
    if (i < cases.length - 1) {
      const pause = (i + 1) % 10 === 0 ? rand(50000, 80000) : rand(15000, 25000);
      log(`  -> pause ${fmt(pause)}`);
      await sleep(pause);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const ok       = results.filter(r => r.ok);
  const failed   = results.filter(r => !r.ok && !r.captcha);
  const captchas = results.filter(r => r.captcha);
  const meoHit   = ok.filter(r => r.hasMeo).length;
  const avgMs    = ok.length ? Math.round(ok.reduce((s, r) => s + r.elapsed, 0) / ok.length) : 0;

  console.log(`
╔════════════════════════════════════════════════╗
║            MEO STRESS TEST SUMMARY             ║
╠════════════════════════════════════════════════╣
║  Total requests     : ${String(results.length).padEnd(24)}║
║  Succeeded          : ${String(ok.length).padEnd(24)}║
║  CAPTCHA hits       : ${String(captchas.length).padEnd(24)}║
║  Other failures     : ${String(failed.length).padEnd(24)}║
╠════════════════════════════════════════════════╣
║  MEO results found  : ${`${meoHit} / ${ok.length}`.padEnd(24)}║
║  Avg time/request   : ${fmt(avgMs).padEnd(24)}║
╚════════════════════════════════════════════════╝`);

  if (failed.length > 0) {
    console.log("\nFailures:");
    failed.forEach(r => console.log(`  "${r.keyword}" @ ${r.location}: ${r.error}`));
  }

  console.log("\nPer-location breakdown:");
  for (const loc of LOCATIONS) {
    const locOk  = ok.filter(r => r.location === loc.name);
    const locMeo = locOk.filter(r => r.hasMeo).length;
    console.log(`  ${loc.name.padEnd(10)} ok: ${locOk.length}/${KEYWORDS.length}  meo hits: ${locMeo}/${KEYWORDS.length}`);
  }
}

run().catch((err: Error) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
