import { describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns";
import { EventIndex } from "../src/events.js";
import { createPublisherReader, datesVerdict, extractPublisherEvidence, freshnessHold, isPublicAddress, type FreshnessEvidence } from "../src/freshness.js";
import { processItems } from "../src/pipeline.js";
import type { JudgmentDraft } from "../src/scoring/types.js";
import { deps, memoryStore } from "./helpers.js";

vi.mock("node:dns", () => ({ lookup: vi.fn() }));

const NOW = "2026-10-07T16:00:00.000Z";
const nowMs = Date.parse(NOW);
const text = "On October 7, the committee approved the amendment. The prior compromise was reached on May 2.";
const evidence: FreshnessEvidence = { url: "https://publisher.example/story", dates: [{ kind: "published", value: "2026-05-04T00:51:56.255Z", source: "JSON-LD datePublished" }], text };
const html = (body = text) => `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", datePublished: "2026-05-04T00:51:56.255Z", dateModified: "2026-10-07T12:00:00Z" })}</script></head><body><article><time datetime="2026-10-07T12:00:00Z">Updated October 7</time><p>${body}</p></article><aside><time datetime="2099-01-01">Related story</time></aside></body></html>`;
const dated = (published?: string, modified?: string): FreshnessEvidence => ({
  url: "https://publisher.example/story",
  dates: [
    ...(published ? [{ kind: "published" as const, value: published, source: "JSON-LD datePublished" }] : []),
    ...(modified ? [{ kind: "modified" as const, value: modified, source: "JSON-LD dateModified" }] : []),
  ],
  text,
});

describe("publisher evidence", () => {
  it("preserves publication, modification and scoped visible dates without choosing the newest", () => {
    const e = extractPublisherEvidence(html(), evidence.url!);
    expect(e.dates).toEqual([
      { kind: "published", value: "2026-05-04T00:51:56.255Z", source: "JSON-LD datePublished" },
      { kind: "modified", value: "2026-10-07T12:00:00Z", source: "JSON-LD dateModified" },
      { kind: "visible", value: "2026-10-07T12:00:00Z", source: "visible time" },
    ]);
    expect(e.text).toContain(text);
    expect(e.text).not.toContain("Related story");
  });

  it("reads graph metadata and articleBody, ignores malformed markup and unrelated schema types", () => {
    const e = extractPublisherEvidence(`<script type="application/ld+json">broken</script><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Organization", datePublished: "2099-01-01" }, { "@type": ["Article"], datePublished: "2026-05-04", articleBody: text }] })}</script><p>Navigation</p>`, evidence.url!);
    expect(e.text).toBe(text);
    expect(e.dates).toHaveLength(1);
  });

  it("reads OpenGraph dates and bounds text", () => {
    const e = extractPublisherEvidence(`<meta property="article:published_time" content="2026-10-07T12:00:00Z"><article>${"x".repeat(20_000)}</article>`, evidence.url!);
    expect(e.dates[0]?.source).toBe("article:published_time");
    expect(e.text).toHaveLength(12_000);
  });

  it("marks pages with no article text unverified", () => {
    expect(extractPublisherEvidence("<nav>Access denied</nav>", evidence.url!).error).toBeDefined();
  });

  it("resolves legacy Google links locally", async () => {
    const id = Buffer.concat([Buffer.from([8, 19, 34, 44]), Buffer.from(evidence.url!), Buffer.from([210, 1, 0])]).toString("base64url");
    const fetchImpl = vi.fn(async () => new Response(html()));
    const e = await createPublisherReader("test", fetchImpl as typeof fetch)(`https://news.google.com/rss/articles/${id}`);
    expect(e.url).toBe(evidence.url);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves opaque Google IDs and parses framed RPC responses", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes("/articles/")) return new Response('<div data-n-a-sg="signature" data-n-a-ts="123"></div>');
      if (url.includes("batchexecute")) {
        const payload = JSON.parse(new URLSearchParams(String(init.body)).get("f.req")!);
        expect(JSON.parse(payload[0][0][1]).slice(-3)).toEqual(["opaque", 123, "signature"]);
        return new Response(`)]}'\n\n123\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", evidence.url])]])}\n`);
      }
      return new Response(html());
    }) as typeof fetch;
    expect((await createPublisherReader("test", fetchImpl)("https://news.google.com/read/opaque")).text).toContain(text);
    expect(calls).toHaveLength(3);
  });

  it("fails closed if Google's resolver changes or returns no publisher", async () => {
    const read = createPublisherReader("test", (async () => new Response("<html>Consent required</html>")) as typeof fetch);
    expect((await read("https://news.google.com/rss/articles/opaque")).error).toMatch(/resolution unavailable/);
  });

  it.each([403, 429, 500])("records inaccessible publishers (HTTP %s) instead of treating the feed date as proof", async (status) => {
    const read = createPublisherReader("test", (async () => new Response("blocked", { status })) as typeof fetch);
    expect(await read(evidence.url!)).toMatchObject({ url: evidence.url, dates: [], text: "", error: `Publisher HTTP ${status}` });
  });

  it("rejects oversized responses and request failures", async () => {
    const large = createPublisherReader("test", (async () => new Response("x".repeat(2 * 1024 * 1024 + 1))) as typeof fetch);
    expect((await large(evidence.url!)).error).toMatch(/too large/);
    const failure = createPublisherReader("test", (async () => { throw new Error("timeout"); }) as typeof fetch);
    expect((await failure(evidence.url!)).error).toBe("timeout");
  });

  it.each(["http://publisher.example/story", "https://127.0.0.1/story", "https://[::1]/story", "https://user:secret@publisher.example/story", "https://publisher.example:3000/story"])("rejects unsafe article targets: %s", async (url) => {
    const fetchImpl = vi.fn();
    expect((await createPublisherReader("test", fetchImpl as typeof fetch)(url)).error).toMatch(/public HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks redirects instead of following one into a private address", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/metadata" } }));
    expect((await createPublisherReader("test", fetchImpl as typeof fetch)(evidence.url!)).error).toMatch(/public HTTPS/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("excludes private, mapped and special-purpose DNS answers", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.2.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::"]) expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("blocks a public-looking hostname whose connection-time DNS answer is private", async () => {
    vi.mocked(lookup).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null, addresses: { address: string; family: number }[]) => void;
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    });
    const e = await createPublisherReader("test")("https://publisher.example/story");
    expect(e.error).toMatch(/Non-public article address/);
    expect(lookup).toHaveBeenCalled();
  });
});

describe("publisher dates", () => {
  it.each([
    ["published within the window", dated("2026-10-07T10:00:00Z"), "fresh"],
    ["published in May, never updated", dated("2026-05-04T00:51:56Z", "2026-05-04T00:51:56Z"), "stale"],
    ["old page updated today", dated("2026-09-13T22:37:07-04:00", "2026-10-07T12:00:00Z"), "unclear"],
    ["no publication date", dated(undefined, "2026-10-07T12:00:00Z"), "unclear"],
    ["unparseable publication date", dated("Oct 7th, 2026"), "unclear"],
    ["publication date in the future", dated("2026-10-09T00:00:00Z"), "unclear"],
  ] as const)("%s", (_, e, expected) => {
    expect(datesVerdict(e, nowMs, 48)).toBe(expected);
  });
});

describe("freshnessHold", () => {
  const url = "https://news.google.com/rss/articles/x";
  it("doesn't hold unreadable pages or items without a link", async () => {
    const judge = vi.fn();
    const read = vi.fn(async () => ({ url: null, dates: [], text: "", error: "Publisher HTTP 403" }));
    expect(await freshnessHold({ read, judge }, url, "t", nowMs, 48)).toBeUndefined();
    expect(await freshnessHold({ read, judge }, null, "t", nowMs, 48)).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();
  });
  it("decides clear dates in code, with no model call", async () => {
    const judge = vi.fn();
    expect(await freshnessHold({ read: async () => dated("2026-05-04T00:51:56Z"), judge }, url, "t", nowMs, 48)).toBe("stale");
    expect(await freshnessHold({ read: async () => dated("2026-10-07T10:00:00Z"), judge }, url, "t", nowMs, 48)).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();
  });
  it.each([[true, undefined], [false, "stale"], [null, "freshness_unverified"]] as const)("asks the model when dates are unclear (%s)", async (verdict, expected) => {
    const judge = vi.fn(async () => verdict);
    const read = async () => dated("2026-05-04T00:51:56Z", "2026-10-07T12:00:00Z");
    expect(await freshnessHold({ read, judge }, url, "Committee approves amendment", nowMs, 48)).toBe(expected);
    expect(judge).toHaveBeenCalledWith("Committee approves amendment", expect.objectContaining({ text }), NOW, 48);
  });
});

async function setup(page: FreshnessEvidence, material = true) {
  const store = await memoryStore();
  const source = await store.createSource({ type: "google-news", name: "Google News: Crypto", config: { query: "CLARITY" } });
  const trade = await store.createTrade({ name: "Crypto", thesis: "Law gets written", keywords: ["CLARITY"], tickers: [], strengthens: [], weakens: [] });
  const judge = vi.fn(async (): Promise<JudgmentDraft> => ({ scorer: "llm:test", eventType: "legislation", consequence: material ? 0.9 : 0.1, urgency: 0.8, material,
    matches: [{ targetKey: `trade:${trade.id}`, name: trade.name, strength: 1 }], rationale: "Important",
    event: { sameAs: null, title: "CLARITY deal", entities: [] },
    impacts: material ? [{ tradeId: trade.id, pillarId: null, effect: "majorly_supports" as const, signalId: null, rationale: "Law advances" }] : [],
  }));
  const read = vi.fn(async () => page);
  const delivery = vi.fn(async () => new Response("ok"));
  const events = new EventIndex({ name: "test", embed: async () => new Float32Array([1, 0]) });
  const d = deps(store, { scorer: { name: "llm:test", judge }, freshness: { read }, now: () => new Date(NOW), events,
    policy: { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1, accumulationWindowHours: 72, maxAlertAgeHours: 48 },
    barkUrl: "https://bark.example/test", barkRequiresMaterial: true, fetch: delivery as typeof fetch });
  const item = { externalId: "clarity", title: "Senators reach stablecoin yield deal to advance CLARITY Act", url: "https://news.google.com/rss/articles/x", publishedAt: NOW };
  return { store, source, d, item, read, delivery };
}

describe("Google freshness before push", () => {
  it("holds the May CLARITY story despite a fresh feed date, and records no impact", async () => {
    const s = await setup(dated("2026-05-04T00:51:56Z"));
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(0);
    expect(s.delivery).not.toHaveBeenCalled();
    expect((await s.store.listObservations())[0]?.judgment?.held).toBe("stale");
    expect(await s.store.impactsSince("1970-01-01T00:00:00Z")).toHaveLength(0);
  });
  it("pushes fresh and unreadable pages", async () => {
    for (const page of [dated("2026-10-07T10:00:00Z"), { url: null, dates: [], text: "", error: "Publisher HTTP 403" }]) {
      const s = await setup(page);
      expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(1);
      expect(s.read).toHaveBeenCalledTimes(1);
    }
  });
  it("only fetches pages for items that could push, and only from Google News", async () => {
    const quiet = await setup(dated("2026-05-04T00:51:56Z"), false);
    await processItems(quiet.d, quiet.source, [quiet.item]);
    expect(quiet.read).not.toHaveBeenCalled();
    const s = await setup(dated("2026-05-04T00:51:56Z"));
    const wire = await s.store.createSource({ type: "rss", name: "Wire", config: { url: "https://wire.example/feed" } });
    expect((await processItems(s.d, wire, [{ ...s.item, url: "https://wire.example/1" }])).alerts).toHaveLength(1);
    expect(s.read).not.toHaveBeenCalled();
  });
});
