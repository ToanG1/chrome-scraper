/**
 * Stress test: 100 keywords × 5 pages each
 *
 * Pacing:
 *   - 0–60s  random pause between each keyword in a group
 *   - 60–120s random pause between groups of 10
 *
 * Run: npx tsx test/stress.ts
 */

import { KEYWORDS } from "./keywords";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const PAGES = 5;
const GROUP_SIZE = 10;

interface SearchResult {
  query: string;
  totalResults?: number;
  error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rand = (min: number, max: number): number =>
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

async function search(query: string): Promise<SearchResult> {
  const res = await fetch(`${API_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, pages: PAGES }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SearchResult>;
}

async function run(): Promise<void> {
  log(`Starting stress test — ${KEYWORDS.length} keywords, ${PAGES} pages each`);
  log(`API: ${API_URL}`);

  const results: { query: string; ok: boolean; elapsed: number; found?: number; error?: string }[] = [];
  const globalStart = Date.now();

  const groups: string[][] = [];
  for (let i = 0; i < KEYWORDS.length; i += GROUP_SIZE) {
    groups.push(KEYWORDS.slice(i, i + GROUP_SIZE));
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    log(`\n── Group ${gi + 1}/${groups.length} ─────────────────────────`);

    for (let ki = 0; ki < group.length; ki++) {
      const query = group[ki];
      const keywordIndex = gi * GROUP_SIZE + ki + 1;
      const t0 = Date.now();

      try {
        log(`[${keywordIndex}/100] "${query}"`);
        const data = await search(query);
        const elapsed = Date.now() - t0;
        results.push({ query, ok: true, elapsed, found: data.totalResults });
        log(`  ✓ ${data.totalResults ?? 0} results in ${fmt(elapsed)}`);
      } catch (err) {
        const elapsed = Date.now() - t0;
        results.push({ query, ok: false, elapsed, error: (err as Error).message });
        log(`  ✗ ${(err as Error).message} (${fmt(elapsed)})`);
      }

      // pauses disabled for fast test run
    }
  }

  const totalTime = Date.now() - globalStart;
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const avgTime = succeeded.length
    ? Math.round(succeeded.reduce((s, r) => s + r.elapsed, 0) / succeeded.length)
    : 0;
  const totalFound = succeeded.reduce((s, r) => s + (r.found ?? 0), 0);

  console.log(`
╔═══════════════════════════════════════════╗
║           STRESS TEST SUMMARY             ║
╠═══════════════════════════════════════════╣
║  Total keywords   : ${String(results.length).padEnd(22)}║
║  Succeeded        : ${String(succeeded.length).padEnd(22)}║
║  Failed           : ${String(failed.length).padEnd(22)}║
║  Total results    : ${String(totalFound).padEnd(22)}║
║  Avg time/keyword : ${fmt(avgTime).padEnd(22)}║
║  Total wall time  : ${fmt(totalTime).padEnd(22)}║
╚═══════════════════════════════════════════╝`);

  if (failed.length > 0) {
    console.log("\nFailed:");
    failed.forEach((r) => console.log(`  - "${r.query}": ${r.error}`));
  }
}

run().catch((err: Error) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
