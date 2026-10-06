import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/sources/feed.js";
import { getAdapter, listAdapters, parseSourceConfig } from "../src/sources/registry.js";
import { fakeFetch } from "./helpers.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseFeed", () => {
  it("parses RSS 2.0", () => {
    const items = parseFeed(fixture("rss.xml"));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: "abc-1",
      title: "Nvidia raises full-year guidance on data center demand",
      url: "https://example.com/nvda?utm_source=rss",
      publishedAt: "Mon, 05 Oct 2026 14:00:00 GMT",
    });
    expect(items[0]?.summary).toContain("analysts cheered");
  });

  it("parses Atom (EDGAR style)", () => {
    const [entry] = parseFeed(fixture("atom.xml"));
    expect(entry).toMatchObject({
      title: "8-K - NVIDIA CORP (0001045810) (Filer)",
      url: "https://www.sec.gov/Archives/edgar/data/1045810/x-index.htm",
      externalId: "urn:tag:sec.gov,2008:accession-number=0001045810-26-000123",
    });
  });
});

describe("adapters", () => {
  const ctx = (routes: Record<string, string | object>) => ({ fetch: fakeFetch(routes), userAgent: "test" });

  it("registers every adapter type", () => {
    expect(listAdapters().map((a) => a.type)).toEqual(
      expect.arrayContaining(["rss", "google-news", "sec-edgar", "hackernews", "reddit", "federal-register", "json", "html", "push"]),
    );
  });

  it("rejects invalid config", () => {
    expect(() => parseSourceConfig("rss", { url: "not a url" })).toThrow();
    expect(() => parseSourceConfig("nope", {})).toThrow(/Unknown source type/);
  });

  it("json adapter maps fields by path", async () => {
    const a = getAdapter("json");
    const config = a.configSchema.parse({
      url: "https://api.example.com/news",
      itemsPath: "data.items",
      fields: { id: "id", title: "headline", url: "links.web", publishedAt: "ts" },
    });
    const items = await a.fetch(
      config,
      ctx({ "https://api.example.com/news": { data: { items: [{ id: 7, headline: "Hello", links: { web: "https://x.com/7" }, ts: "2026-10-01" }] } } }),
    );
    expect(items).toEqual([
      expect.objectContaining({ externalId: "7", title: "Hello", url: "https://x.com/7", publishedAt: "2026-10-01" }),
    ]);
  });

  it("html adapter scrapes with selectors and resolves relative links", async () => {
    const html = `<ul><li class="pr"><a href="/news/1">Acme to acquire Widget Co</a><time datetime="2026-10-02">Oct 2</time></li>
      <li class="pr"><a href="https://other.com/2">Second</a></li></ul>`;
    const a = getAdapter("html");
    const config = a.configSchema.parse({
      url: "https://ir.acme.com/press",
      itemSelector: "li.pr",
      fields: { title: "a", date: "time", dateAttribute: "datetime" },
    });
    const items = await a.fetch(config, ctx({ "https://ir.acme.com/press": html }));
    expect(items).toEqual([
      expect.objectContaining({ title: "Acme to acquire Widget Co", url: "https://ir.acme.com/news/1", publishedAt: "2026-10-02" }),
      expect.objectContaining({ title: "Second", url: "https://other.com/2" }),
    ]);
  });

  it("hackernews adapter maps Algolia hits", async () => {
    const a = getAdapter("hackernews");
    const items = await a.fetch(
      a.configSchema.parse({ query: "nvidia" }),
      ctx({ "https://hn.algolia.com/": { hits: [{ objectID: "1", title: "Show HN", created_at: "2026-10-01T00:00:00Z" }] } }),
    );
    expect(items[0]).toMatchObject({ externalId: "1", url: "https://news.ycombinator.com/item?id=1" });
  });

  it("reddit adapter falls back to RSS when JSON is blocked", async () => {
    const a = getAdapter("reddit");
    const rss = readFileSync(new URL("./fixtures/atom.xml", import.meta.url), "utf8");
    const items = await a.fetch(a.configSchema.parse({ subreddit: "stocks" }), ctx({ "https://www.reddit.com/r/stocks/new/.rss": rss }));
    expect(items.length).toBeGreaterThan(0);
  });

  it("federal register adapter maps documents", async () => {
    const a = getAdapter("federal-register");
    const items = await a.fetch(
      a.configSchema.parse({}),
      ctx({ "https://www.federalregister.gov/": { results: [{ document_number: "2026-1", title: "Export controls", html_url: "https://fr.gov/1" }] } }),
    );
    expect(items[0]).toMatchObject({ externalId: "2026-1", title: "Export controls", url: "https://fr.gov/1" });
  });

  it("surfaces HTTP errors", async () => {
    const a = getAdapter("rss");
    await expect(a.fetch(a.configSchema.parse({ url: "https://missing.example.com/feed" }), ctx({}))).rejects.toThrow(/HTTP 404/);
  });
});
