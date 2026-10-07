import { z } from "zod";
import { parseFeed } from "./feed.js";
import { httpGet } from "./http.js";
import { defineAdapter } from "./types.js";

/**
 * SEC EDGAR filings via the EDGAR Atom endpoints. Without `cik` this reads the
 * latest filings across all companies; with `cik` it reads one company.
 * SEC requires a descriptive User-Agent (set USER_AGENT).
 */
export const edgarAdapter = defineAdapter({
  type: "sec-edgar",
  // Per-company feeds reuse titles like "8-K - Current report" for every filing.
  dedupeByTitle: false,
  description: "SEC EDGAR filings (e.g. 8-K, 10-Q, S-1, 13D), market-wide or for one company CIK.",
  configSchema: z.object({
    forms: z.array(z.string()).min(1).default(["8-K"]),
    cik: z.string().optional(),
    count: z.number().int().min(1).max(100).default(40),
    /** Keep only filings by watched companies. */
    watchedOnly: z.boolean().default(false),
  }),
  async fetch(config, ctx) {
    const items = [];
    for (const form of config.forms) {
      const url = new URL("https://www.sec.gov/cgi-bin/browse-edgar");
      url.searchParams.set("action", config.cik ? "getcompany" : "getcurrent");
      if (config.cik) url.searchParams.set("CIK", config.cik);
      url.searchParams.set("type", form);
      url.searchParams.set("owner", "include");
      url.searchParams.set("count", String(config.count));
      url.searchParams.set("output", "atom");
      items.push(...parseFeed(await httpGet(ctx, url.toString())));
    }
    return items;
  },
});
