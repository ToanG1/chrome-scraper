import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { scrapeSerp, fetchUrl, closeSession } from "./scraper";
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

// POST /fetch  { "url": "https://..." }
// Navigate Chrome to any URL and return raw HTML — for custom SERP formats
// like MEO (udm=1, rflfq=1) or SEO (num=100) with uule location encoding.
app.post("/fetch", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => null);
  const url = body?.url?.trim();
  if (!url) return c.json({ error: "url is required" }, 400);

  try {
    const html = await fetchUrl(url);
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8" });
  } catch (err) {
    console.error("[fetch]", (err as Error).message);
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
