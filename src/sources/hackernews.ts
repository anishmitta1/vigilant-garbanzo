import { z } from "zod";
import type { RawItem } from "../types.js";
import { asString, httpGetJson } from "./http.js";
import { defineAdapter } from "./types.js";

interface Hit {
  objectID: string;
  title?: string;
  url?: string;
  story_text?: string;
  created_at?: string;
  points?: number;
}

export const hackerNewsAdapter = defineAdapter({
  type: "hackernews",
  description: "Hacker News stories via the Algolia search API, optionally filtered by query and minimum points.",
  configSchema: z.object({
    query: z.string().default(""),
    minPoints: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async fetch(config, ctx) {
    const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
    url.searchParams.set("tags", "story");
    url.searchParams.set("query", config.query);
    url.searchParams.set("hitsPerPage", String(config.limit));
    if (config.minPoints > 0) url.searchParams.set("numericFilters", `points>=${config.minPoints}`);
    const body = (await httpGetJson(ctx, url.toString())) as { hits?: Hit[] };
    return (body.hits ?? []).map(
      (h): RawItem => ({
        externalId: h.objectID,
        title: asString(h.title) ?? "",
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        summary: h.story_text,
        publishedAt: h.created_at,
        raw: { points: h.points },
      }),
    );
  },
});
