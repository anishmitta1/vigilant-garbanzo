import { z } from "zod";
import { parseFeed } from "./feed.js";
import { httpGet } from "./http.js";
import { defineAdapter } from "./types.js";

export const rssAdapter = defineAdapter({
  type: "rss",
  description:
    "Any RSS/Atom/RDF feed: news sites, Substack, blogs, Reddit (.rss), YouTube channels, arXiv, GitHub releases, central banks.",
  configSchema: z.object({
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Keep only items whose title names a watched company (for high-volume wires). */
    watchedOnly: z.boolean().default(false),
  }),
  async fetch(config, ctx) {
    return parseFeed(await httpGet(ctx, config.url, config.headers));
  },
});
