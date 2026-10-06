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
