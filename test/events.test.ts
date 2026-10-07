import { describe, expect, it } from "vitest";
import { buildDigest, pillarGaps } from "../src/digest.js";
import { EventIndex, newImpacts, type Embedder } from "../src/events.js";
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
