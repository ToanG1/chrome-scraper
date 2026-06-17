/**
 * Extract sample MEO + SEO results for a few city/keyword combos,
 * save raw HTML to test/samples/ and print extracted JSON to stdout.
 *
 * Run: npx tsx test/extract-sample.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const SAMPLES_DIR = path.join(__dirname, "samples");

fs.mkdirSync(SAMPLES_DIR, { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────

interface MeoResult {
  rank: number;
  name: string;
  rating: string;
  reviewCount: string;
  address: string;
  category: string;
}

interface SeoResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
}

interface SampleResult {
  type: "MEO" | "SEO";
  query: string;
  location: string;
  lat: number;
  lon: number;
  htmlBytes: number;
  results: MeoResult[] | SeoResult[];
  fetchedAt: string;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseMeo(html: string): MeoResult[] {
  const $ = cheerio.load(html);
  const results: MeoResult[] = [];

  // Local pack entries — Google Maps results use these containers
  $(".rllt__details, [data-local-attribute], .VkpGBb").each((i, el) => {
    const block = $(el);
    const name = block.find(".dbg0pd span, .OSrXXb, .qBF1Pd").first().text().trim() ||
                 block.find("span[aria-level]").first().text().trim();
    if (!name) return;

    const ratingEl = block.find(".BTtC6e, .yi40Hd, .fTKmHE09lmd__rating-stars");
    const rating = ratingEl.first().text().trim() ||
                   block.find("[aria-label*='stars'], [aria-label*='つ星']").attr("aria-label") || "";
    const reviewCount = block.find(".RDApEe, .jdzyld").first().text().trim();
    const address = block.find(".rllt__wrapped .rllt__details div:last-child, .W4Efsd:last-child").first().text().trim();
    const category = block.find(".rllt__details .rllt__category, .YhR4Z").first().text().trim();

    results.push({ rank: results.length + 1, name, rating, reviewCount, address, category });
    if (results.length >= 10) return false;
  });

  // Fallback: look for hqp_pb containers (Maps local pack)
  if (results.length === 0) {
    $("[data-hveid] .rllt__wrapped, .cXedhc").each((i, el) => {
      const name = $(el).find("span.OSrXXb, .qBF1Pd, span[role='heading']").first().text().trim();
      const address = $(el).find(".W4Efsd").last().text().trim();
      if (name) {
        results.push({ rank: results.length + 1, name, rating: "", reviewCount: "", address, category: "" });
      }
      if (results.length >= 10) return false;
    });
  }

  return results;
}

function parseSeo(html: string): SeoResult[] {
  const $ = cheerio.load(html);
  const results: SeoResult[] = [];

  $("[data-snc]").each((_, container) => {
    $(container).find("h3.LC20lb").each((_, h3) => {
      const titleEl = $(h3);
      const anchor = titleEl.closest("a");
      const url = anchor.attr("href") ?? "";
      const title = titleEl.text().trim();
      const snippet = anchor.closest("[data-snc]").find(".VwiC3b").first().text().trim();
      if (title && url.startsWith("http")) {
        results.push({ rank: results.length + 1, title, url, snippet });
      }
    });
    if (results.length >= 20) return false;
  });

  return results;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

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

async function fetchSeo(query: string, lat: number, lon: number): Promise<string> {
  const res = await fetch(`${API_URL}/fetch/seo`, {
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

// ── Samples ───────────────────────────────────────────────────────────────────

const SAMPLES = [
  { query: "sushi",  location: "Tokyo-Shinjuku", lat: 35.689487, lon: 139.691711 },
  { query: "ラーメン", location: "Osaka",          lat: 34.6937,  lon: 135.5023  },
  { query: "カフェ",   location: "Kyoto",          lat: 35.0116,  lon: 135.7681  },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log(`Extracting ${SAMPLES.length * 2} samples (MEO + SEO per location)\n`);
  const summary: SampleResult[] = [];

  for (const s of SAMPLES) {
    for (const type of ["MEO", "SEO"] as const) {
      const label = `${type} "${s.query}" @ ${s.location}`;
      process.stdout.write(`Fetching ${label}... `);
      try {
        const html = type === "MEO"
          ? await fetchMeo(s.query, s.lat, s.lon)
          : await fetchSeo(s.query, s.lat, s.lon);

        const slug = `${type.toLowerCase()}_${s.location.replace(/[^a-z0-9]/gi, "_")}_${s.query.replace(/[^a-z0-9]/gi, "_")}`;
        const htmlPath = path.join(SAMPLES_DIR, `${slug}.html`);
        fs.writeFileSync(htmlPath, html, "utf-8");

        const results = type === "MEO" ? parseMeo(html) : parseSeo(html);
        const entry: SampleResult = {
          type,
          query: s.query,
          location: s.location,
          lat: s.lat,
          lon: s.lon,
          htmlBytes: html.length,
          results,
          fetchedAt: new Date().toISOString(),
        };
        summary.push(entry);

        console.log(`OK  ${(html.length / 1024).toFixed(0)}KB  ${results.length} results  → ${slug}.html`);
        console.log("  Top 3:");
        results.slice(0, 3).forEach((r, i) => {
          if (type === "MEO") {
            const m = r as MeoResult;
            console.log(`    ${i + 1}. ${m.name}  ${m.rating}  ${m.address}`);
          } else {
            const o = r as SeoResult;
            console.log(`    ${i + 1}. ${o.title}`);
            console.log(`       ${o.url.slice(0, 80)}`);
          }
        });
        console.log();
      } catch (err) {
        console.log(`FAIL  ${(err as Error).message}`);
      }

      await sleep(6000);
    }
  }

  const jsonPath = path.join(SAMPLES_DIR, "results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\nAll results saved to test/samples/results.json`);
}

run().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
