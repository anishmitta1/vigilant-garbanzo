import { XMLParser } from "fast-xml-parser";
import type { RawItem } from "../types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: true,
});

type Node = Record<string, unknown>;

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function text(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Node)["#text"]);
  return undefined;
}

function atomLink(v: unknown): string | undefined {
  const links = arr(v as Node | Node[] | undefined);
  const alt = links.find((l) => typeof l === "object" && (!l["@_rel"] || l["@_rel"] === "alternate"));
  const chosen = alt ?? links[0];
  if (typeof chosen === "string") return chosen;
  return chosen ? text(chosen["@_href"]) : undefined;
}

/** Parse RSS 2.0, RSS 1.0 (RDF), or Atom into raw items. */
export function parseFeed(xml: string): RawItem[] {
  const doc = parser.parse(xml) as Node;

  const rss = doc.rss as Node | undefined;
  const rdf = doc.RDF as Node | undefined;
  const rssItems = arr((rss?.channel as Node | undefined)?.item ?? rdf?.item) as Node[];
  if (rssItems.length > 0) {
    return rssItems.map((it) => {
      const link = text(it.link);
      const title = text(it.title) ?? "";
      return {
        externalId: text(it.guid) ?? link ?? title,
        title,
        url: link,
        summary: text(it.description) ?? text(it.encoded),
        publishedAt: text(it.pubDate) ?? text(it.date),
      };
    });
  }

  const feed = doc.feed as Node | undefined;
  return (arr(feed?.entry) as Node[]).map((e) => {
    const link = atomLink(e.link);
    const title = text(e.title) ?? "";
    return {
      externalId: text(e.id) ?? link ?? title,
      title,
      url: link,
      summary: text(e.summary) ?? text(e.content),
      publishedAt: text(e.updated) ?? text(e.published),
    };
  });
}
