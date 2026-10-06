import { load } from "cheerio";
import type { NewObservation } from "./db.js";
import type { RawItem } from "./types.js";
import { sha256 } from "./util.js";

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid)$/i;
const MAX_SUMMARY = 2000;

export function stripHtml(input: string): string {
  if (!/[<&]/.test(input)) return collapse(input);
  return collapse(load(`<div>${input}</div>`)("div").first().text());
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** Title fingerprint used to catch the same story syndicated under different URLs. */
export function titleFingerprint(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/\s[-|–—]\s[^-|–—]{2,40}$/, "") // trailing " - Publisher"
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return sha256(normalized);
}

function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalize(sourceId: string, item: RawItem): NewObservation | null {
  const title = stripHtml(item.title ?? "");
  if (!title) return null;
  const url = item.url ? canonicalUrl(item.url) : null;
  return {
    sourceId,
    externalId: item.externalId || url || title,
    url,
    title,
    summary: stripHtml(item.summary ?? "").slice(0, MAX_SUMMARY),
    publishedAt: toIso(item.publishedAt),
    urlHash: url ? sha256(url) : null,
    titleHash: titleFingerprint(title),
    raw: item.raw,
  };
}

const STORY_STOPWORDS = new Set(
  "the and for with from that this into over after amid as at by in of on to its it is are was were be has have had will would could says said new how why what who than more most about against".split(" "),
);

/** Significant lowercase tokens of a headline, without a trailing " - Outlet" suffix (Google News style). */
export function storyTokens(title: string): Set<string> {
  const parts = title.split(" - ");
  const core = parts.length > 1 && parts.at(-1)!.split(/\s+/).length <= 6 ? parts.slice(0, -1).join(" - ") : title;
  return new Set(
    core
      .toLowerCase()
      .split(/[^\p{L}\p{N}$]+/u)
      .filter((t) => (t.length >= 3 || /\d/.test(t)) && !STORY_STOPWORDS.has(t)),
  );
}

/** Two headlines describe the same story if most of the shorter one's significant tokens appear in the other. */
export function sameStory(a: string, b: string): boolean {
  const ta = storyTokens(a);
  const tb = storyTokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= 3 && shared / Math.min(ta.size, tb.size) >= 0.6;
}
