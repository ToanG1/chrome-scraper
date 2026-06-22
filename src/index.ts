import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { scrapeSerp, fetchUrl, fetchMeoOrganic, searchInBox, closeSession } from "./scraper";
import { healthCheck } from "./browser";

const app = new Hono();
const PORT = Number(process.env.PORT) || 3000;

app.get("/health", async (c) => {
  try {
    const info = await healthCheck();
    return c.json({ status: "ok", browser: info.Browser });
  } catch (err) {
    return c.json({ status: "error", message: (err as Error).message }, 503);
  }
});

// POST /search  { "query": "...", "pages": 1-10 }
app.post("/search", async (c) => {
  const body = await c.req.json<{ query?: string; pages?: number }>().catch(() => null);
  const query = body?.query?.trim();
  if (!query) return c.json({ error: "query is required" }, 400);

  const pages = Math.min(Math.max(1, Number(body?.pages) || 1), 10);

  try {
    return c.json(await scrapeSerp(query, pages));
  } catch (err) {
    console.error("[scrape]", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /search/batch  { "queries": ["q1", "q2"], "pages": 1-10 }
app.post("/search/batch", async (c) => {
  const body = await c
    .req.json<{ queries?: string[]; pages?: number }>()
    .catch(() => null);
  const queries = body?.queries;
  if (!Array.isArray(queries) || queries.length === 0)
    return c.json({ error: "queries array is required" }, 400);

  const pages = Math.min(Math.max(1, Number(body?.pages) || 1), 10);
  const results = [];

  for (const q of queries.slice(0, 20)) {
    try {
      results.push(await scrapeSerp(q.trim(), pages));
    } catch (err) {
      results.push({ query: q, error: (err as Error).message });
    }
  }
  return c.json({ results });
});

// POST /fetch  { "url": "...", "proxy": "...", "warmUpQuery": "sushi" }
// warmUpQuery: do a plain Google search first before navigating to url,
// mimicking a human who searches then opens the parameterized SERP URL.
app.post("/fetch", async (c) => {
  const body = await c.req.json<{ url?: string; proxy?: string; warmUpQuery?: string }>().catch(() => null);
  const url = body?.url?.trim();
  const proxy = body?.proxy?.trim() || undefined;
  const warmUpQuery = body?.warmUpQuery?.trim() || undefined;
  if (!url) return c.json({ error: "url is required" }, 400);

  try {
    const html = await fetchUrl(url, proxy, warmUpQuery);
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  } catch (err) {
    console.error("[fetch]", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /fetch/meo  { "query": "sushi", "lat": 35.689487, "lon": 139.691711 }
// Builds the MEO SERP URL using sll/fll parameters — works from any IP, no proxy needed.
app.post("/fetch/meo", async (c) => {
  const body = await c.req.json<{ query?: string; lat?: number; lon?: number }>().catch(() => null);
  const query = body?.query?.trim();
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  if (!query) return c.json({ error: "query is required" }, 400);
  if (!lat || !lon) return c.json({ error: "lat and lon are required" }, 400);

  const span = "0.04,0.065";
  const url =
    `https://www.google.com/search?q=${encodeURIComponent(query)}` +
    `&hl=ja&gl=jp&pws=0&npsic=0&rflfq=1&rldoc=1&rlha=0&sa=X&udm=1` +
    `&fll=${lat},${lon}&fspn=${span}&fz=14` +
    `&sll=${lat},${lon}&sspn=${span}&sz=14&stq=1&cs=0`;

  try {
    const html = await fetchUrl(url, undefined, query);
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  } catch (err) {
    console.error("[meo]", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /fetch/seo  { "query": "sushi", "lat": 35.689487, "lon": 139.691711 }
// Builds the SEO organic SERP URL pinned to coordinates via sll.
app.post("/fetch/seo", async (c) => {
  const body = await c.req.json<{ query?: string; lat?: number; lon?: number }>().catch(() => null);
  const query = body?.query?.trim();
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  if (!query) return c.json({ error: "query is required" }, 400);
  if (!lat || !lon) return c.json({ error: "lat and lon are required" }, 400);

  const url =
    `https://www.google.com/search?q=${encodeURIComponent(query)}` +
    `&hl=ja&gl=jp&num=100&brd_scroll=1&pws=0&ie=UTF-8&oe=UTF-8` +
    `&sll=${lat},${lon}`;

  try {
    const html = await fetchUrl(url, undefined, query);
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  } catch (err) {
    console.error("[seo]", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /fetch/meo-organic  { "query": "sushi" }
// Fully organic flow: google.co.jp homepage → omnibox keyword → Maps tab click.
// No complex URL parameters — all actions produce isTrusted=true events.
app.post("/fetch/meo-organic", async (c) => {
  const body = await c.req.json<{ query?: string }>().catch(() => null);
  const query = body?.query?.trim();
  if (!query) return c.json({ error: "query is required" }, 400);
  try {
    const html = await fetchMeoOrganic(query);
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  } catch (err) {
    console.error("[meo-organic]", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /fetch/search-in-box  { "query": "ramen" }
// Types the query into the search box of the current tab and waits for results.
// Reuses the location context from the previous /fetch MEO URL — no complex params needed.
app.post("/fetch/search-in-box", async (c) => {
  const body = await c.req.json<{ query?: string }>().catch(() => null);
  const query = body?.query?.trim();
  if (!query) return c.json({ error: "query is required" }, 400);
  try {
    const html = await searchInBox(query);
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  } catch (err) {
    console.error("[search-in-box]", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

process.on("SIGTERM", async () => {
  await closeSession();
  process.exit(0);
});

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`chrome-scraper on :${PORT}`),
);
