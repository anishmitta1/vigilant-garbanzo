import { describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns";
import { EventIndex } from "../src/events.js";
import { createLlmFreshness, createPublisherReader, datesVerdict, extractPublisherEvidence, freshnessHold, isPublicAddress, publisherFeedEvidence, type FreshnessDecision, type FreshnessEvidence } from "../src/freshness.js";
import { processItems } from "../src/pipeline.js";
import type { JudgmentDraft } from "../src/scoring/types.js";
import { deps, memoryStore } from "./helpers.js";

vi.mock("node:dns", () => ({ lookup: vi.fn() }));

const NOW = "2026-10-07T16:00:00.000Z";
const nowMs = Date.parse(NOW);
const text = "On October 7, 2026, the committee approved the amendment. The prior compromise was reached on May 2.";
const evidence: FreshnessEvidence = { url: "https://publisher.example/story", dates: [{ kind: "published", value: "2026-05-04T00:51:56.255Z", source: "JSON-LD datePublished" }], text };
const review = (fresh: boolean | null, lookupUrl?: string): FreshnessDecision => ({ fresh, newFact: fresh ? "The committee approved an amendment" : "", rationale: "Article evidence", sources: [{ url: evidence.url!, quote: text }], ...(lookupUrl ? { lookupUrl } : {}) });
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
  it("reads the main story, not earlier recommendation cards (Sesterce regression)", () => {
    const e = extractPublisherEvidence(`<main><article class="card"><meta itemprop="datePublished" content="2026-04-14"><p>Old recommendation</p></article><article itemprop="mainEntity"><h1>New campus</h1><time itemprop="datePublished" datetime="2026-10-08">Today</time><div itemprop="articleBody"><p>A new campus was announced <a href="/original">in this release</a>.</p></div><article><time itemprop="datePublished" datetime="2026-05-06">Related</time><p>Another old card</p></article></article></main>`, evidence.url!);
    expect(e.dates).toEqual([{ kind: "published", value: "2026-10-08", source: "datePublished" }]);
    expect(e.text).toBe("A new campus was announced in this release.");
    expect(e.links?.[0]).toMatchObject({ url: "https://publisher.example/original", text: "in this release" });
  });

  it("selects JSON-LD for the canonical article rather than unrelated graph stories", () => {
    const e = extractPublisherEvidence(`<link rel="canonical" href="https://publisher.example/story"><script type="application/ld+json">${JSON.stringify({ "@graph": [
      { "@type": "NewsArticle", url: "https://publisher.example/other", datePublished: "2026-04-14", articleBody: "Wrong story" },
      { "@type": "NewsArticle", mainEntityOfPage: { "@id": "https://publisher.example/story" }, datePublished: "2026-10-08", articleBody: text },
    ] })}</script>`, evidence.url!);
    expect(e.dates).toEqual([{ kind: "published", value: "2026-10-08", source: "JSON-LD datePublished" }]);
    expect(e.text).toBe(text);
  });

  it("does not arbitrarily pick an unidentified article from a multi-story graph", () => {
    const e = extractPublisherEvidence(`<script type="application/ld+json">${JSON.stringify([
      { "@type": "Article", datePublished: "2026-04-14" }, { "@type": "Article", datePublished: "2026-10-08" },
    ])}</script><article><p>${text}</p></article>`, evidence.url!);
    expect(e.dates).toEqual([]);
    expect(e.text).toBe(text);
  });

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
  it("holds unreadable pages and items without a link, and records why", async () => {
    const judge = vi.fn();
    const read = vi.fn(async () => ({ url: null, dates: [], text: "", error: "Publisher HTTP 403" }));
    const record = vi.fn();
    expect(await freshnessHold({ read, judge, record }, url, "t", nowMs, 48)).toBe("freshness_unverified");
    expect(record.mock.calls[0]?.[0].rationale).toContain("HTTP 403");
    expect(await freshnessHold({ read, judge, record }, null, "t", nowMs, 48)).toBe("freshness_unverified");
    expect(record.mock.calls[1]?.[0].rationale).toContain("No source URL");
    expect(judge).not.toHaveBeenCalled();
  });
  it("does not trust publisher dates when no novelty model is configured", async () => {
    expect(await freshnessHold({ read: async () => dated("2026-05-04T00:51:56Z") }, url, "t", nowMs, 48)).toBe("freshness_unverified");
    expect(await freshnessHold({ read: async () => dated("2026-10-07T10:00:00Z") }, url, "t", nowMs, 48)).toBe("freshness_unverified");
  });
  it("fails closed on reader and judge exceptions", async () => {
    for (const check of [
      { read: async () => { throw new Error("timeout"); } },
      { read: async () => dated("2026-10-07T10:00:00Z"), judge: async () => { throw new Error("outage"); } },
    ]) expect(await freshnessHold(check, url, "t", nowMs, 48)).toBe("freshness_unverified");
  });
  it("can verify already-read first-party feed evidence when the article page is blocked", async () => {
    const judge = vi.fn(async (title: string, page: FreshnessEvidence) => ({ ...review(true), newFact: title, sources: [{ url: page.url!, quote: page.text }] }));
    const feed = { ...dated("2026-10-07T10:00:00Z"), url };
    expect(await freshnessHold({ read: async () => ({ url: null, dates: [], text: "", error: "blocked" }), judge }, url, "t", nowMs, 48, { publisherFeed: feed })).toBeUndefined();
    expect(judge.mock.calls[0]?.[1]).toEqual(feed);
  });
  it.each([[true, undefined], [false, "stale"], [null, "freshness_unverified"]] as const)("asks the model when dates are unclear (%s)", async (verdict, expected) => {
    const judge = vi.fn(async () => review(verdict));
    const read = async () => dated("2026-05-04T00:51:56Z", "2026-10-07T12:00:00Z");
    expect(await freshnessHold({ read, judge }, url, "Committee approves amendment", nowMs, 48)).toBe(expected);
    expect(judge).toHaveBeenCalledWith("Committee approves amendment", expect.objectContaining({ text }), NOW, 48, {});
  });

  it("checks a fresh article for an old development instead of bypassing the model", async () => {
    const judge = vi.fn(async () => review(false));
    expect(await freshnessHold({ read: async () => dated("2026-10-07T10:00:00Z"), judge }, url, "August order recap", nowMs, 48)).toBe("stale");
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("allows a genuinely new disclosure even on an old page without modification metadata", async () => {
    const judge = vi.fn(async () => review(true));
    expect(await freshnessHold({ read: async () => dated("2026-05-04T00:51:56Z"), judge }, url, "Newly released documents", nowMs, 48)).toBeUndefined();
  });

  it("follows one supplied citation, then records the final decision and history", async () => {
    const link = "https://original.example/release";
    const page = { ...dated("2026-10-07T10:00:00Z"), links: [{ url: link, text: "announcement", context: "As previously announced" }] };
    const read = vi.fn(async (u: string) => u === url ? page : dated("2026-05-04T00:51:56Z"));
    const judge = vi.fn().mockResolvedValueOnce(review(null, link)).mockResolvedValueOnce(review(false));
    const record = vi.fn();
    const context = { events: [{ title: "An earlier deal", firstSeenAt: NOW, items: ["Earlier report"] }] };
    expect(await freshnessHold({ read, judge, record }, url, "Deal recap", nowMs, 48, context)).toBe("stale");
    expect(read.mock.calls.map((c) => c[0])).toEqual([url, link]);
    expect(judge.mock.calls[1]?.[4]).toEqual({ ...context, references: [dated("2026-05-04T00:51:56Z")] });
    expect(record).toHaveBeenCalledWith(review(false));
  });

  it("never fetches invented URLs and caps citation lookups at one", async () => {
    const link = "https://original.example/release";
    for (const requested of ["https://invented.example/story", link]) {
      const read = vi.fn(async () => ({ ...dated("2026-10-07T10:00:00Z"), links: [{ url: link, text: "release", context: "release" }] }));
      const judge = vi.fn(async () => review(null, requested));
      expect(await freshnessHold({ read, judge }, url, "t", nowMs, 48)).toBe("freshness_unverified");
      expect(read).toHaveBeenCalledTimes(requested === link ? 2 : 1);
      expect(judge).toHaveBeenCalledTimes(requested === link ? 2 : 1);
    }
  });
});

describe("source-grounded novelty model", () => {
  const llm = { apiKey: "test", baseUrl: "https://llm.example", model: "test" };
  const response = (result: unknown) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))) as typeof fetch;
  it("accepts a quoted new disclosure and includes article, citations and event memory", async () => {
    const fetchImpl = vi.fn(response({ new_information: true, first_public_at: "2026-10-07", origin_url: evidence.url, new_fact: "New amendment approved", rationale: "New vote", sources: [{ url: evidence.url, quote: text }] }));
    expect((await createLlmFreshness(llm, fetchImpl)("t", evidence, NOW, 48, { events: [] })).fresh).toBe(true);
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const input = JSON.parse(payload.messages[1].content);
    expect(input.article).toMatchObject({ url: evidence.url, text });
    expect(input.known_events).toEqual([]);
    expect(payload.max_tokens).toBe(800);
  });
  it.each([
    { new_information: true, new_fact: "New", sources: [] },
    { new_information: true, new_fact: "", sources: [{ url: evidence.url, quote: text }] },
    { new_information: true, new_fact: "New", sources: [{ url: "https://invented.example/story", quote: text }] },
    { new_information: false, sources: [{ url: evidence.url, quote: "A fabricated passage" }] },
    { new_information: "true", sources: [{ url: evidence.url, quote: text }] },
  ])("treats ungrounded or malformed verdicts as unknown", async (result) => {
    expect((await createLlmFreshness(llm, response({ rationale: "reason", ...result }))("t", evidence, NOW, 48)).fresh).toBeNull();
  });
  it("accepts evidence only from successfully read pages, not blocked references", async () => {
    const reference = { url: "https://original.example", dates: [], text: "Original announcement was in May", error: "blocked" };
    const judge = createLlmFreshness(llm, response({ new_information: false, rationale: "Old", sources: [{ url: reference.url, quote: reference.text }] }));
    expect((await judge("t", evidence, NOW, 48, { references: [reference] })).fresh).toBeNull();
  });
  it("computes the date window in code rather than trusting the model's date arithmetic", async () => {
    const judge = createLlmFreshness(llm, response({ new_information: true, first_public_at: "2026-09-24", new_fact: "Rules proposed", rationale: "Within window", sources: [{ url: evidence.url, quote: text }] }));
    expect((await judge("t", evidence, NOW, 48)).fresh).toBe(false);
  });
  it("traces a cited original report even when the model calls the re-report fresh", async () => {
    const url = "https://original.example/report";
    const page = { ...evidence, links: [{ url, text: "original report", context: "According to the original report" }] };
    const judge = createLlmFreshness(llm, response({ new_information: true, first_public_at: "2026-10-07", origin_url: url, new_fact: "New fact", rationale: "Claim originates elsewhere", sources: [{ url: evidence.url, quote: text }] }));
    expect(await judge("t", page, NOW, 48)).toMatchObject({ fresh: null, lookupUrl: url });
  });
  it("requires a disclosure date and a known origin for a positive verdict", async () => {
    for (const extra of [{ origin_url: evidence.url }, { first_public_at: "2026-10-07" }]) {
      const judge = createLlmFreshness(llm, response({ new_information: true, new_fact: "New fact", rationale: "New", sources: [{ url: evidence.url, quote: text }], ...extra }));
      expect((await judge("t", evidence, NOW, 48)).fresh).toBeNull();
    }
  });
  it("does not accept a guessed disclosure date absent from source metadata and quotes", async () => {
    const page = { ...evidence, text: "The company is partnering with another company on a venture." };
    const judge = createLlmFreshness(llm, response({ new_information: true, first_public_at: "2026-10-07", origin_url: page.url, new_fact: "New venture", rationale: "New", sources: [{ url: page.url, quote: page.text }] }));
    expect((await judge("t", page, NOW, 48)).fresh).toBeNull();
  });
  it("requires a quote from the originating report, not merely its re-report", async () => {
    const reference = { ...dated("2026-10-07T10:00:00Z"), url: "https://original.example/report", text: "The original document approved a new amendment." };
    const judge = createLlmFreshness(llm, response({ new_information: true, first_public_at: "2026-10-07", origin_url: reference.url, new_fact: "New amendment", rationale: "New", sources: [{ url: evidence.url, quote: text }] }));
    expect((await judge("t", evidence, NOW, 48, { references: [reference] })).fresh).toBeNull();
  });
  it.each(["2099-01-01", "2026-10-07T16:05:00Z"])("does not accept a future disclosure date (%s)", async (date) => {
    const judge = createLlmFreshness(llm, response({ new_information: true, first_public_at: date, new_fact: "Rules proposed", rationale: "New", sources: [{ url: evidence.url, quote: text }] }));
    expect((await judge("t", evidence, NOW, 48)).fresh).toBeNull();
  });
  it.each(["invalid JSON", "outage"])("returns unknown on %s", async (failure) => {
    const fetchImpl = (async () => failure === "outage" ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "{" } }] }))) as typeof fetch;
    expect((await createLlmFreshness(llm, fetchImpl)("t", evidence, NOW, 48)).fresh).toBeNull();
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
  const d = deps(store, { scorer: { name: "llm:test", judge }, freshness: { read, judge: async () => review(true) }, now: () => new Date(NOW), events,
    policy: { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1, accumulationWindowHours: 72, maxAlertAgeHours: 48 },
    barkUrl: "https://bark.example/test", barkRequiresMaterial: true, fetch: delivery as typeof fetch });
  const item = { externalId: "clarity", title: "Senators reach stablecoin yield deal to advance CLARITY Act", url: "https://news.google.com/rss/articles/x", publishedAt: NOW };
  return { store, source, d, item, read, delivery };
}

describe("verified novelty before any push", () => {
  it("uses only same-publisher RSS evidence, never Google or cross-host feed snippets", async () => {
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    const wire = await s.store.createSource({ type: "rss", name: "Wire", config: { url: "https://www.wire.example/feed" } });
    const item = { url: "https://wire.example/release", title: "A new agreement", summary: "A multi-year binding deal was announced today.", publishedAt: NOW };
    expect(publisherFeedEvidence(wire, item)).toMatchObject({ url: item.url, dates: [{ source: "Publisher RSS feed", value: NOW }], text: expect.stringContaining(item.summary) });
    expect(publisherFeedEvidence(s.source, item)).toBeUndefined();
    expect(publisherFeedEvidence(wire, { ...item, url: "https://other.example/release" })).toBeUndefined();
    expect(publisherFeedEvidence(wire, { ...item, url: "http://wire.example/release" })).toBeUndefined();
    expect(publisherFeedEvidence({ ...wire, config: { url: "https://news.google.com/rss" } }, { ...item, url: "https://news.google.com/rss/articles/x" })).toBeUndefined();
  });
  it("holds a fresh recap without adding impacts, and stores the grounded reason", async () => {
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    const judge = vi.fn(async () => review(false));
    s.d.freshness = { read: s.read, judge };
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(0);
    expect(s.delivery).not.toHaveBeenCalled();
    const judgment = (await s.store.listObservations())[0]?.judgment;
    expect(judgment?.held).toBe("stale");
    expect(judgment?.rationale).toContain("Novelty check: Article evidence");
    expect(judgment?.rationale).toContain(evidence.url!);
    expect(await s.store.impactsSince("1970-01-01T00:00:00Z")).toHaveLength(0);
    expect(judge.mock.calls[0]).toHaveLength(5);
  });

  it("holds readable but unsupported evidence as unverified, not stale", async () => {
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    s.d.freshness = { read: s.read, judge: async () => review(null) };
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(0);
    expect((await s.store.listObservations())[0]?.judgment?.held).toBe("freshness_unverified");
    expect(s.delivery).not.toHaveBeenCalled();
    expect(await s.store.impactsSince("1970-01-01T00:00:00Z")).toHaveLength(0);
  });
  it("holds the May CLARITY story despite a fresh feed date, and records no impact", async () => {
    const s = await setup(dated("2026-05-04T00:51:56Z"));
    s.d.freshness = { read: s.read, judge: async () => review(false) };
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(0);
    expect(s.delivery).not.toHaveBeenCalled();
    expect((await s.store.listObservations())[0]?.judgment?.held).toBe("stale");
    expect(await s.store.impactsSince("1970-01-01T00:00:00Z")).toHaveLength(0);
  });
  it("pushes a verified fresh disclosure", async () => {
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(1);
    expect(s.read).toHaveBeenCalledTimes(1);
    expect(s.delivery).toHaveBeenCalledTimes(1);
  });
  it("holds unreadable pages without delivery or fresh pillar evidence", async () => {
    const s = await setup({ url: null, dates: [], text: "", error: "Publisher HTTP 403" });
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(0);
    expect(s.read).toHaveBeenCalledTimes(1);
    expect(s.delivery).not.toHaveBeenCalled();
    expect((await s.store.listObservations())[0]?.judgment?.held).toBe("freshness_unverified");
    expect(await s.store.impactsSince("1970-01-01T00:00:00Z")).toHaveLength(0);
  });
  it("fails closed if the checker is missing on a delivery path", async () => {
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    s.d.freshness = undefined;
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(0);
    expect(s.delivery).not.toHaveBeenCalled();
  });
  it("only fetches candidates that could push, but also verifies wire stories", async () => {
    const quiet = await setup(dated("2026-05-04T00:51:56Z"), false);
    await processItems(quiet.d, quiet.source, [quiet.item]);
    expect(quiet.read).not.toHaveBeenCalled();
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    const wire = await s.store.createSource({ type: "rss", name: "Wire", config: { url: "https://wire.example/feed" } });
    expect((await processItems(s.d, wire, [{ ...s.item, url: "https://wire.example/1" }])).alerts).toHaveLength(1);
    expect(s.read).toHaveBeenCalledTimes(1);
  });
  it.each(["rss", "sec-edgar", "push"] as const)("does not exempt %s from verification", async (type) => {
    const s = await setup({ url: null, dates: [], text: "", error: "Blocked" });
    const source = await s.store.createSource({ type, name: "Other source", config: {} });
    expect((await processItems(s.d, source, [s.item])).alerts).toHaveLength(0);
    expect(s.read).toHaveBeenCalledTimes(1);
    expect(s.delivery).not.toHaveBeenCalled();
  });
  it("keeps an already-alerted event silent even when the later report passes novelty review", async () => {
    const s = await setup(dated("2026-10-07T10:00:00Z"));
    expect((await processItems(s.d, s.source, [s.item])).alerts).toHaveLength(1);
    const priorId = (await s.store.listAlerts(1))[0]!.eventId!;
    s.d.scorer = { name: "llm:test", judge: async () => ({ scorer: "llm:test", eventType: "legislation", consequence: 0.9, urgency: 1, material: true,
      matches: [{ targetKey: "trade:test", name: "Crypto", strength: 1 }], rationale: "Same deal", event: { sameAs: priorId, title: "CLARITY deal", entities: [] }, impacts: [] }) };
    expect((await processItems(s.d, s.source, [{ ...s.item, externalId: "second", title: "A different outlet reports the Senate stablecoin compromise" }])).alerts).toHaveLength(0);
    expect(s.delivery).toHaveBeenCalledTimes(1);
  });
});
