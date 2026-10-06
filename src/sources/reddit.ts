import { z } from "zod";
import type { RawItem } from "../types.js";
import { parseFeed } from "./feed.js";
import { httpGet, httpGetJson } from "./http.js";
import { defineAdapter } from "./types.js";

interface Post {
  id: string;
  title: string;
  url?: string;
  permalink: string;
  selftext?: string;
  created_utc: number;
  score?: number;
}

export const redditAdapter = defineAdapter({
  type: "reddit",
  description: "Posts from a subreddit via Reddit's JSON listing, falling back to its RSS feed when JSON is blocked.",
  configSchema: z.object({
    subreddit: z.string().regex(/^[A-Za-z0-9_]+$/),
    sort: z.enum(["new", "hot", "top", "rising"]).default("new"),
    minScore: z.number().int().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async fetch(config, ctx) {
    const url = `https://www.reddit.com/r/${config.subreddit}/${config.sort}.json?limit=${config.limit}&raw_json=1`;
    let body: { data?: { children?: { data: Post }[] } };
    try {
      body = (await httpGetJson(ctx, url)) as typeof body;
    } catch (err) {
      // Reddit often returns 403 to datacenter IPs on .json but still serves RSS (without scores).
      try {
        return parseFeed(await httpGet(ctx, `https://www.reddit.com/r/${config.subreddit}/${config.sort}/.rss`));
      } catch {
        throw err;
      }
    }
    return (body.data?.children ?? [])
      .map((c) => c.data)
      .filter((p) => (p.score ?? 0) >= config.minScore)
      .map(
        (p): RawItem => ({
          externalId: p.id,
          title: p.title,
          url: p.url && !p.url.includes("/comments/") ? p.url : `https://www.reddit.com${p.permalink}`,
          summary: p.selftext,
          publishedAt: new Date(p.created_utc * 1000).toISOString(),
          raw: { score: p.score, permalink: p.permalink },
        }),
      );
  },
});
