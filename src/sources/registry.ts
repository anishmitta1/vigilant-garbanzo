import { edgarAdapter } from "./edgar.js";
import { federalRegisterAdapter } from "./federal-register.js";
import { googleNewsAdapter } from "./google-news.js";
import { hackerNewsAdapter } from "./hackernews.js";
import { htmlAdapter } from "./html.js";
import { jsonAdapter } from "./json.js";
import { pushAdapter } from "./push.js";
import { redditAdapter } from "./reddit.js";
import { rssAdapter } from "./rss.js";
import type { SourceAdapter } from "./types.js";

const adapters: SourceAdapter<never>[] = [
  rssAdapter,
  googleNewsAdapter,
  edgarAdapter,
  hackerNewsAdapter,
  redditAdapter,
  federalRegisterAdapter,
  jsonAdapter,
  htmlAdapter,
  pushAdapter,
] as SourceAdapter<never>[];

const byType = new Map(adapters.map((a) => [a.type, a as SourceAdapter<unknown>]));

export function getAdapter(type: string): SourceAdapter<unknown> {
  const adapter = byType.get(type);
  if (!adapter) throw new Error(`Unknown source type: ${type}`);
  return adapter;
}

export function listAdapters(): { type: string; description: string }[] {
  return adapters.map((a) => ({ type: a.type, description: a.description }));
}

/** Validate and apply defaults to a source config. Throws a ZodError on invalid config. */
export function parseSourceConfig(type: string, config: unknown): unknown {
  return getAdapter(type).configSchema.parse(config ?? {});
}
