/**
 * Direct full-URL MEO stress test
 *
 * Every request hits /fetch/meo directly — no searchInBox, no omnibox.
 * Tests whether the mature profile can handle repeated full-URL access
 * (hl=ja&gl=jp&pws=0&npsic=0&rflfq=1&rldoc=1&uule=lat,lon) without CAPTCHA.
 *
 * Run: npx tsx test/direct-url-test.ts
 */

const API_URL = process.env.API_URL ?? "http://localhost:3000";

const LOCATIONS = [
  { name: "Tokyo",    lat: 35.6762,  lon: 139.6503  },
  { name: "Osaka",    lat: 34.6937,  lon: 135.5023  },
  { name: "Kyoto",    lat: 35.0116,  lon: 135.7681  },
  { name: "Yokohama", lat: 35.4437,  lon: 139.6380  },
  { name: "Sapporo",  lat: 43.0621,  lon: 141.3544  },
];

const KEYWORDS = [
  "sushi", "ramen", "ラーメン店", "居酒屋", "カフェ",
  "ホテル", "美容院", "歯医者", "観光スポット", "tempura",
];

interface Case { keyword: string; location: string; lat: number; lon: number }
const cases: Case[] = [];
for (const loc of LOCATIONS) {
  for (const kw of KEYWORDS) {
    cases.push({ keyword: kw, location: loc.name, lat: loc.lat, lon: loc.lon });
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const rand  = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function fetchMeo(query: string, lat: number, lon: number): Promise<string> {
  const res = await fetch(`${API_URL}/fetch/meo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, lat, lon }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(b.error ?? `HTTP ${res.status}`);
  }
  return res.text();
}

function htmlStats(html: string) {
  return {
    kb: (html.length / 1024).toFixed(0),
    meo: html.includes("rllt__") || html.includes("hqp_pb") || html.includes("data-cid"),
    captcha: html.includes("/sorry/index") && !html.includes("indexOf(\"/sorry/index\")"),
    lang: /^<html[^>]+lang="ja"/.test(html.slice(0, 300)) ? "ja"
         : /^<html[^>]+lang="vi"/.test(html.slice(0, 300)) ? "vi" : "?",
  };
}

async function run() {
  log(`Direct URL MEO test — ${cases.length} requests (${LOCATIONS.length} locs × ${KEYWORDS.length} kw)`);
  log(`Every request: POST /fetch/meo with full params + uule=lat,lon`);

  const results: { ok: boolean; meo: boolean; captcha: boolean; lang: string; elapsed: number; error?: string }[] = [];

  for (let i = 0; i < cases.length; i++) {
    const { keyword, location, lat, lon } = cases[i];
    log(`[${i + 1}/${cases.length}] "${keyword}" @ ${location} (${lat},${lon})`);
    const t0 = Date.now();

    try {
      const html = await fetchMeo(keyword, lat, lon);
      const elapsed = Date.now() - t0;
      const s = htmlStats(html);
      results.push({ ok: true, meo: s.meo, captcha: s.captcha, lang: s.lang, elapsed });
      const flag = s.captcha ? " ⚠ CAPTCHA IN HTML" : "";
      log(`  OK  ${s.kb}KB  meo=${s.meo}  lang=${s.lang}  ${fmt(elapsed)}${flag}`);
    } catch (err) {
      const elapsed = Date.now() - t0;
      const msg = (err as Error).message;
      const isCaptcha = msg.toLowerCase().includes("captcha") || msg.toLowerCase().includes("sorry");
      results.push({ ok: false, meo: false, captcha: isCaptcha, lang: "?", elapsed, error: msg });
      log(`  ${isCaptcha ? "CAPTCHA" : "FAIL"}  ${msg}`);
      if (isCaptcha) {
        log(`  pausing 5 minutes…`);
        await sleep(300_000);
      }
    }

    if (i < cases.length - 1) {
      const pause = (i + 1) % 10 === 0 ? rand(50_000, 80_000) : rand(12_000, 20_000);
      log(`  → pause ${fmt(pause)}`);
      await sleep(pause);
    }
  }

  const ok       = results.filter(r => r.ok);
  const captchas = results.filter(r => r.captcha);
  const failed   = results.filter(r => !r.ok && !r.captcha);
  const meoHit   = ok.filter(r => r.meo).length;
  const jaCount  = ok.filter(r => r.lang === "ja").length;
  const avgMs    = ok.length ? Math.round(ok.reduce((s, r) => s + r.elapsed, 0) / ok.length) : 0;

  console.log(`
╔══════════════════════════════════════════════════╗
║         DIRECT URL MEO TEST SUMMARY              ║
╠══════════════════════════════════════════════════╣
║  Total requests     : ${String(results.length).padEnd(26)}║
║  Succeeded          : ${String(ok.length).padEnd(26)}║
║  CAPTCHA hits       : ${String(captchas.length).padEnd(26)}║
║  Other failures     : ${String(failed.length).padEnd(26)}║
╠══════════════════════════════════════════════════╣
║  MEO results found  : ${`${meoHit} / ${ok.length}`.padEnd(26)}║
║  Japanese lang=ja   : ${`${jaCount} / ${ok.length}`.padEnd(26)}║
║  Avg time/request   : ${fmt(avgMs).padEnd(26)}║
╚══════════════════════════════════════════════════╝`);

  if (captchas.length > 0) console.log("\n⚠ CAPTCHA requests:", captchas.map((_, i) => results.indexOf(_) + 1));

  console.log("\nPer-location:");
  for (const loc of LOCATIONS) {
    const lr = ok.filter((_, i) => results.indexOf(_) !== -1 && cases[results.indexOf(_)]?.location === loc.name);
    const locAll = ok.filter((r, i) => {
      const idx = results.indexOf(r);
      return cases[idx]?.location === loc.name;
    });
    const locMeo = locAll.filter(r => r.meo).length;
    const locJa  = locAll.filter(r => r.lang === "ja").length;
    console.log(`  ${loc.name.padEnd(10)} ok: ${locAll.length}/${KEYWORDS.length}  meo: ${locMeo}  lang=ja: ${locJa}`);
  }
}

run().catch(e => { console.error("Fatal:", (e as Error).message); process.exit(1); });
