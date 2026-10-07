import { describe, expect, it } from "vitest";
import { buildDigest, pillarGaps } from "../src/digest.js";
import { EventIndex, findCandidates, newImpacts, warmEventMemory, type Embedder } from "../src/events.js";
import { processItems } from "../src/pipeline.js";
import type { JudgeContext, JudgmentDraft, Scorer } from "../src/scoring/types.js";
import type { ImpactDraft, Observation } from "../src/types.js";
import { deps, memoryStore } from "./helpers.js";

/** Bag-of-words vectors: shared words mean similar vectors, which is all grouping needs from the real model. */
const wordEmbedder: Embedder = {
  name: "words",
  async embed(text) {
    const v = new Float32Array(64);
    for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
      v[h]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  },
};

async function setup() {
  const store = await memoryStore();
  const trade = await store.createTrade({
    name: "Power & nuclear demand",
    thesis: "AI power demand",
    keywords: [],
    tickers: ["CEG"],
    strengthens: [],
    weakens: [],
    entities: [{ name: "Alphabet", aliases: ["Google"] }],
    pillars: [
      { statement: "Big buyers pay for firm power.", signals: [{ description: "Hyperscaler signs a nuclear PPA", effect: "majorly_supports" }] },
      { statement: "New generation gets built.", signals: [] },
    ],
  });
  const source = await store.createSource({ type: "push", name: "wire", config: {} });
  return { store, trade, source, firm: trade.pillars[0]!, build: trade.pillars[1]! };
}

/** Says an item reports on the first open event iff its title mentions Constellation and one is open. */
function stubScorer(impactsFor: (title: string) => ImpactDraft[]): Scorer & { contexts: JudgeContext[] } {
  const contexts: JudgeContext[] = [];
  return {
    name: "llm:stub",
    contexts,
    async judge(o: Observation, _s, watchlist, context = {}): Promise<JudgmentDraft> {
      contexts.push({ ...context, evidence: context.evidence && [...context.evidence] });
      const trade = watchlist.trades[0]!;
      const open = context.candidates?.find((c) => c.title.includes("Constellation"));
      const sameAs = o.title.includes("Constellation") && open ? open.id : null;
      const impacts = sameAs ? [] : impactsFor(o.title);
      return {
        scorer: "llm:stub",
        eventType: "deal",
        consequence: 0.8,
        urgency: 0.6,
        matches: impacts.length > 0 || sameAs ? [{ targetKey: `trade:${trade.id}`, name: trade.name, strength: 1, direction: "strengthens" }] : [],
        rationale: "r",
        // A model may still call a re-report material; the event layer must hold it anyway.
        material: sameAs !== null || impacts.some((i) => i.effect.startsWith("majorly")),
        event: { sameAs, title: o.title.includes("Constellation") ? "Google–Constellation nuclear PPA" : o.title, entities: [] },
        impacts,
      };
    },
  };
}

describe("event grouping", () => {
  it("holds a differently worded re-report of an alerted event and records no new evidence", async () => {
    const { store, trade, source, firm } = await setup();
    const scorer = stubScorer(() => [{ tradeId: trade.id, pillarId: firm.id, effect: "majorly_supports", signalId: "1", rationale: "PPA" }]);
    const d = { ...deps(store), scorer, events: new EventIndex(wordEmbedder) };

    const first = await processItems(d, source, [{ externalId: "1", title: "Google signs 20-year nuclear deal with Constellation" }]);
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]!.eventId).toBeTruthy();

    const second = await processItems(d, source, [{ externalId: "2", title: "Alphabet partners with Constellation Energy, boosting uranium stocks" }]);
    expect(second.alerts).toHaveLength(0);
    // The alerted event was offered even though the headlines share few words.
    expect(scorer.contexts[1]!.candidates?.map((c) => c.alerted)).toEqual([true]);
    const rows = await store.digestRows(new Date(0).toISOString());
    expect(rows.find((r) => r.title.startsWith("Alphabet"))?.judgment.held).toBe("same_event");
    expect(await store.eventImpacts(first.alerts[0]!.eventId!)).toHaveLength(1);
    // Evidence offered to later items counts the development once.
    await processItems(d, source, [{ externalId: "3", title: "Unrelated grid story" }]);
    expect(scorer.contexts[2]!.evidence).toHaveLength(1);
  });

  it("in events mode, pushes on new major pillar moves only, good or bad", async () => {
    const { store, trade, source, firm, build } = await setup();
    const effects: Record<string, ImpactDraft["effect"]> = { Microsoft: "majorly_falsifies", NRC: "slightly_supports" };
    const scorer = stubScorer((title) => {
      const key = Object.keys(effects).find((k) => title.includes(k));
      return key ? [{ tradeId: trade.id, pillarId: key === "NRC" ? build.id : firm.id, effect: effects[key]!, signalId: null, rationale: "" }] : [];
    });
    const policy = { ...deps(store).policy, alertMode: "events" as const };
    const d = { ...deps(store), scorer, policy, events: new EventIndex(wordEmbedder) };

    const r = await processItems(d, source, [
      { externalId: "1", title: "Microsoft cancels nuclear power contract" },
      { externalId: "2", title: "NRC schedules hearing on plant uprate" },
      { externalId: "3", title: "Weather is nice" },
    ]);
    expect(r.alerts.map((a) => a.targetKey)).toEqual([`trade:${trade.id}`]);
    expect(await pillarGaps(store, new Date(0).toISOString())).toEqual([]);
  });

  it("merges near-identical reports without a model verdict and keeps different ones apart", async () => {
    const { store, source } = await setup();
    const d = { ...deps(store), events: new EventIndex(wordEmbedder) };
    await processItems(d, source, [
      { externalId: "1", title: "Treasury yields climb to highest since 2007" },
      { externalId: "2", title: "Treasury yields climb to highest since 2007 today" },
      { externalId: "3", title: "Gold rate in Mumbai today" },
    ], { baseline: true });
    const n = await store.client.execute("SELECT COUNT(*) AS n FROM events");
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it("remembers an earlier push even after more than five other developments and an embedding failure", async () => {
    const { store, trade, source, firm } = await setup();
    const scorer = stubScorer(() => [{ tradeId: trade.id, pillarId: firm.id, effect: "majorly_supports", signalId: null, rationale: "deal" }]);
    const d = { ...deps(store), scorer, events: new EventIndex(wordEmbedder) };
    await processItems(d, source, [{ externalId: "first", title: "Google signs nuclear deal with Constellation" }]);
    for (let n = 0; n < 7; n++) {
      await processItems(d, source, [{ externalId: `other-${n}`, title: `Company ${n} announces a separate power project` }]);
    }
    const broken = new EventIndex({ name: "broken", embed: async () => { throw new Error("offline"); } });
    const result = await processItems({ ...d, events: broken }, source, [{ externalId: "copy", title: "Alphabet partners with Constellation" }]);
    expect(scorer.contexts.at(-1)?.candidates).toHaveLength(8);
    expect(result.alerts).toHaveLength(0);
    expect((await store.digestRows(new Date(0).toISOString())).find((r) => r.title.startsWith("Alphabet"))?.judgment.held).toBe("same_event");
    const outsideWindow = await findCandidates(store, broken, null, Date.now() + 49 * 3600_000);
    expect(outsideWindow).toEqual([]);
  });

  it("does not let a re-report create a major upgrade, a new pillar impact, or an accumulated alert", async () => {
    const { store, trade, source, firm, build } = await setup();
    let call = 0;
    const scorer: Scorer = {
      name: "test",
      async judge(o, _s, _w, context) {
        return {
          scorer: "test", eventType: "deal", consequence: 0.5, urgency: 0.5,
          material: ++call > 1, matches: [{ targetKey: `trade:${trade.id}`, name: trade.name, strength: 1, direction: "strengthens" }], rationale: "deal",
          event: { sameAs: context?.candidates?.[0]?.id ?? null, title: o.title, entities: [] },
          impacts: [
            { tradeId: trade.id, pillarId: firm.id, effect: call === 1 ? "slightly_supports" : "majorly_supports", signalId: null, rationale: "deal" },
            ...(call > 1 ? [{ tradeId: trade.id, pillarId: build.id, effect: "majorly_supports" as const, signalId: null, rationale: "re-rated" }] : []),
          ],
        };
      },
    };
    const d = { ...deps(store), scorer, events: new EventIndex(wordEmbedder) };
    await processItems(d, source, [{ externalId: "first", title: "Google signs Constellation PPA" }]);
    const copy = await processItems(d, source, [{ externalId: "copy", title: "Google signs Constellation PPA in long-term nuclear deal" }]);
    expect(copy.alerts).toHaveLength(0);
    const eventId = (await store.client.execute("SELECT id FROM events")).rows[0]!.id as string;
    expect(await store.eventImpacts(eventId)).toHaveLength(1);
    const targets = await store.client.execute("SELECT created_at FROM judgment_targets ORDER BY rowid");
    expect(targets.rows).toHaveLength(2);
    expect(targets.rows[1]!.created_at).toBe(new Date(0).toISOString());
  });

  it("keeps a new decision separate even when it has nearly the same wording as the earlier event", async () => {
    const { store, trade, source, firm } = await setup();
    let call = 0;
    const scorer: Scorer = {
      name: "test",
      async judge(o) {
        const effect = ++call === 1 ? "majorly_supports" as const : "majorly_falsifies" as const;
        return {
          scorer: "test", eventType: "deal", consequence: 0.8, urgency: 0.8, material: true,
          matches: [{ targetKey: `trade:${trade.id}`, name: trade.name, strength: 1 }], rationale: "New decision",
          event: { sameAs: null, title: o.title, entities: ["Alphabet", "Constellation"] },
          impacts: [{ tradeId: trade.id, pillarId: firm.id, effect, signalId: null, rationale: "New decision" }],
        };
      },
    };
    const d = deps(store, { policy: { ...deps(store).policy, alertMode: "events" }, scorer, events: new EventIndex({ name: "identical-vectors", embed: async () => Float32Array.of(1) }) });
    await processItems(d, source, [{ externalId: "first", title: "Google signs Constellation power deal" }]);
    const next = await processItems(d, source, [{ externalId: "reversal", title: "Google cancels Constellation power deal" }]);
    expect(next.alerts).toHaveLength(1);
    expect((await store.client.execute("SELECT COUNT(*) AS n FROM events")).rows[0]!.n).toBe(2);
    expect((await store.impactsSince(new Date(0).toISOString())).map((e) => e.effect).sort()).toEqual(["majorly_falsifies", "majorly_supports"]);
  });

  it("silently warms memory from legacy pushes and does not replay deliveries on restart", async () => {
    const { store, trade, source, firm } = await setup();
    const scorer = stubScorer(() => [{ tradeId: trade.id, pillarId: firm.id, effect: "majorly_supports", signalId: null, rationale: "PPA" }]);
    const d = { ...deps(store), scorer };
    const first = await processItems(d, source, [{ externalId: "first", title: "Google signs nuclear deal with Constellation" }]);
    const second = await processItems(d, source, [{ externalId: "second", title: "Alphabet partners with Constellation" }]);
    expect(first.alerts.concat(second.alerts)).toHaveLength(2);
    const before = (await store.client.execute("SELECT * FROM alerts ORDER BY rowid")).rows;
    const index = new EventIndex(wordEmbedder);
    await warmEventMemory(store, index, scorer, Date.now());
    const after = (await store.client.execute("SELECT * FROM alerts ORDER BY rowid")).rows;
    expect(after.map((r) => r.event_id)).toEqual([after[0]!.event_id, after[0]!.event_id]);
    expect(after[0]!.event_id).toBeTruthy();
    for (let n = 0; n < before.length; n++) expect({ ...after[n], event_id: null }).toEqual(before[n]);
    const calls = scorer.contexts.length;
    await warmEventMemory(store, new EventIndex(wordEmbedder), scorer, Date.now());
    expect(scorer.contexts).toHaveLength(calls);
    const third = await processItems({ ...d, events: new EventIndex(wordEmbedder) }, source, [{ externalId: "third", title: "Uranium miners rally on Constellation's Google deal" }]);
    expect(third.alerts).toHaveLength(0);
    expect((await store.client.execute("SELECT COUNT(*) AS n FROM impacts")).rows[0]!.n).toBe(1);
  });
});

describe("weak candidate retrieval", () => {
  it("offers unalerted events even below the old similarity cutoff, bounded to three", async () => {
    const { store } = await setup();
    const index = new EventIndex(wordEmbedder);
    const now = Date.now();
    await index.load(store, now);
    const ids: string[] = [];
    for (const score of [0.1, 0.2, 0.3, 0.4]) {
      const event = await store.createEvent({ title: `Event ${score}`, type: "deal", entities: [], firstSeenAt: new Date(now).toISOString() });
      ids.push(event.id);
      index.add(event.id, Float32Array.from([score, Math.sqrt(1 - score * score)]), now);
    }
    const candidates = await findCandidates(store, index, Float32Array.from([1, 0]), now);
    expect(candidates.map((candidate) => candidate.id)).toEqual(ids.slice(1).reverse());
    expect(candidates.every((candidate) => !candidate.alerted && candidate.similarity < 0.6)).toBe(true);
  });
});

describe("warm-up fallback", () => {
  it("logs incomplete model evidence while linking old alerts without redelivery", async () => {
    const { store, trade, source } = await setup();
    const scorer = stubScorer(() => [{ tradeId: trade.id, pillarId: null, effect: "majorly_supports", signalId: null, rationale: "PPA" }]);
    await processItems({ ...deps(store), scorer }, source, [{ externalId: "old", title: "Google signs power deal" }]);
    const fallback: Scorer = {
      name: "llm:unavailable",
      judge: async () => ({ scorer: "heuristic", eventType: "deal", consequence: 0, urgency: 0, matches: [], rationale: "model unavailable" }),
    };
    const log: string[] = [];
    await warmEventMemory(store, new EventIndex(wordEmbedder), fallback, Date.now(), (message) => log.push(message));
    expect(log.some((message) => message.includes("impact history may be incomplete"))).toBe(true);
    expect(log).not.toContain("event memory ready");
    expect(await store.listAlerts()).toHaveLength(1);
    expect(await store.alertedEventIdsSince(new Date(0).toISOString())).toHaveLength(1);
  });
});

describe("newImpacts", () => {
  const base = { tradeId: "t", signalId: null, rationale: "" };
  it("adds pillars the event hadn't moved, and upgrades slight to major once", () => {
    const existing = [{ ...base, pillarId: "p1", effect: "slightly_supports" as const }];
    expect(
      newImpacts(existing, [
        { ...base, pillarId: "p1", effect: "slightly_supports" },
        { ...base, pillarId: "p1", effect: "majorly_supports" },
        { ...base, pillarId: "p2", effect: "slightly_falsifies" },
        { ...base, pillarId: "p2", effect: "slightly_falsifies" },
      ]).map((i) => `${i.pillarId} ${i.effect}`),
    ).toEqual(["p1 majorly_supports", "p2 slightly_falsifies"]);
  });
});

describe("pillars", () => {
  it("shows only the latest reading of an event per pillar, with rationale and shared event identity", async () => {
    const { store, source, trade, firm, build } = await setup();
    const observation = await store.insertObservation({ sourceId: source.id, externalId: "a", title: "PPA", url: null, urlHash: null, titleHash: "ppa", summary: "", publishedAt: null, raw: null });
    const event = await store.createEvent({ title: "Binding PPA", type: "deal", entities: ["Alphabet"], firstSeenAt: "2026-10-05T00:00:00Z" });
    const base = { eventId: event.id, observationId: observation!.id, tradeId: trade.id, signalId: null };
    await store.insertImpact({ ...base, pillarId: firm.id, effect: "slightly_supports", rationale: "Preliminary", createdAt: "2026-10-05T00:00:00Z" });
    await store.insertImpact({ ...base, pillarId: firm.id, effect: "majorly_supports", rationale: "Now binding", createdAt: "2026-10-06T00:00:00Z" });
    await store.insertImpact({ ...base, pillarId: build.id, effect: "slightly_supports", rationale: "Capacity needs building", createdAt: "2026-10-06T00:00:00Z" });
    await store.insertImpact({ ...base, pillarId: null, effect: "slightly_falsifies", rationale: "Balance sheet concern", createdAt: "2026-10-06T00:00:00Z" });
    const evidence = await store.impactsSince("2026-10-01T00:00:00Z");
    expect(evidence).toHaveLength(3);
    expect(evidence.find((e) => e.pillarId === firm.id)).toMatchObject({ eventId: event.id, effect: "majorly_supports", rationale: "Now binding" });
    expect(evidence.every((e) => e.eventId === event.id)).toBe(true);
    expect((await store.eventSummaries([event.id]))[0]!.impacts).toHaveLength(4);
  });
  it("stores pillars with short signal ids, and retires without deleting", async () => {
    const { store, firm } = await setup();
    expect(firm.signals[0]).toMatchObject({ id: "1", effect: "majorly_supports" });
    expect(await store.setPillarActive(firm.id, false)).toBe(true);
    const [trade] = await store.listTrades();
    expect(trade!.pillars.map((p) => p.active)).toEqual([false, true]);
    expect(trade!.entities).toEqual([{ name: "Alphabet", aliases: ["Google"] }]);
  });

  it("lists events that fit no pillar in the digest", () => {
    const digest = buildDigest([], { dateLabel: "Oct 6", failingSources: [], gaps: [{ trade: "AI infra buildout", events: ["Chip tariff probe", "x"] }] });
    expect(digest.body).toContain("AI infra buildout: 2 events, e.g. Chip tariff probe");
  });
});
