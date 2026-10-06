import { z } from "zod";
import { parseFeed } from "./feed.js";
import { httpGet } from "./http.js";
import { defineAdapter } from "./types.js";

export const googleNewsAdapter = defineAdapter({
  type: "google-news",
  description: "Google News search results for a query (supports operators like site:, when:7d, OR).",
  configSchema: z.object({
    query: z.string().min(1),
    language: z.string().default("en-US"),
    country: z.string().default("US"),
  }),
  async fetch(config, ctx) {
    const lang = config.language.split("-")[0];
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", config.query);
    url.searchParams.set("hl", config.language);
    url.searchParams.set("gl", config.country);
    url.searchParams.set("ceid", `${config.country}:${lang}`);
    return parseFeed(await httpGet(ctx, url.toString()));
  },
});
