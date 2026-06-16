import * as cheerio from "cheerio";

export interface OrganicResult {
  title: string;
  url: string;
  snippet: string;
  page: number;
}

export interface ParsedSerp {
  organic: Omit<OrganicResult, "page">[];
  featuredSnippet: string | null;
}

export function parseSerp(html: string, _query: string): ParsedSerp {
  const $ = cheerio.load(html);
  const organic: Omit<OrganicResult, "page">[] = [];

  // Real Google SERP DOM (verified live):
  // [data-snc] → outer per-result wrapper
  //   [data-snhf="0"] > .yuRUbf > a.zReHs > h3.LC20lb  (title + url)
  //   [data-sncf="1"] > .VwiC3b                          (snippet, sibling of above)
  $("[data-snc]").each((_, el) => {
    const title = $(el).find("h3.LC20lb").first().text().trim();
    const url = $(el).find("a.zReHs[href]").first().attr("href") ?? "";
    const snippet = $(el).find(".VwiC3b").first().text().trim();
    if (title && url.startsWith("http")) {
      organic.push({ title, url, snippet });
    }
  });

  const featuredSnippet = $(".hgKElc, .ILfuVd").first().text().trim() || null;

  return { organic: organic.slice(0, 10), featuredSnippet };
}
