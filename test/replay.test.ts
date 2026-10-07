import { describe, expect, it } from "vitest";
import { PRESET_TRADES } from "../src/presets.js";
import { historyScorer, replayHistory, type CachedVerdict, type HistoryRow } from "../src/replay.js";
import type { JudgmentDraft, Scorer } from "../src/scoring/types.js";
import { memoryStore } from "./helpers.js";

const policy = {
  alertThreshold: 0.6,
  weakSignalFloor: 0.2,
  accumulationThreshold: 1.2,
  accumulationWindowHours: 72,
  maxAlertAgeHours: 48,
  storyWindowHours: 48,
  materialMinScore: 0.5,
};

async function setup() {
  const store = await memoryStore();
  const trade = await store.createTrade({ ...PRESET_TRADES[0]!, preset: true });
  const source = await store.createSource({ type: "rss", name: "Wire", config: { url: "https://example.com/feed" } });
  const verdict = (material: boolean, consequence: number): JudgmentDraft => ({
    scorer: "llm:test",
    eventType: "capex",
    consequence,
    urgency: 0.5,
    matches: [{ targetKey: `trade:${trade.id}`, name: trade.name, strength: 1, direction: "strengthens" }],
    rationale: "why",
    material,
  });
  const row = (id: string, title: string, fetchedAt: string, v: JudgmentDraft | null, extra: Partial<HistoryRow> = {}): HistoryRow => ({
    sourceId: source.id,
    externalId: id,
    title,
    url: null,
    summary: "",
    publishedAt: new Date(Date.parse(fetchedAt) - 5 * 60_000).toISOString(),
    fetchedAt,
    verdict: v,
    baseline: false,
    ...extra,
  });
  const rows = [
    row("0", "First poll item on hyperscaler capex", "2026-10-01T14:00:00Z", verdict(true, 0.9), { baseline: true }),
    row("1", "Microsoft doubles data center capex", "2026-10-01T15:00:00Z", verdict(true, 0.7)),
    row("2", "Microsoft doubles data center capex", "2026-10-01T15:10:00Z", verdict(true, 0.7)),
    row("3", "Analyst reiterates Nvidia rating", "2026-10-01T16:00:00Z", verdict(false, 0.4)),
    row("4", "Old Oracle cloud contract story", "2026-10-01T17:00:00Z", verdict(true, 0.9), { publishedAt: "2026-09-20T00:00:00Z" }),
    row("5", "Meta weighs new Louisiana campus", "2026-10-02T15:00:00Z", verdict(true, 0.45)),
  ];
  return { store, rows };
}

describe("replay", () => {
  it("replays saved verdicts at each item's fetch time with production's holds", async () => {
    const { store, rows } = await setup();
    const result = await replayHistory(store, rows, { scorer: historyScorer(rows), policy });
    expect(result.pushes.map((p) => p.title)).toEqual(["Microsoft doubles data center capex"]);
    expect(result.pushes[0]!.lateMinutes).toBe(5);
    expect(result.held).toEqual({ baseline: 1, stale: 1 });
    expect(result.nearMisses.map((r) => r.title)).toEqual(["Meta weighs new Louisiana campus", "Analyst reiterates Nvidia rating"]);
    expect(result.days).toBe(1);

    const again = await replayHistory(store, rows, { scorer: historyScorer(rows), policy });
    expect(again.pushes.map((p) => [p.at, p.title])).toEqual(result.pushes.map((p) => [p.at, p.title]));
  });

  it("sweeps the importance bar", async () => {
    const { store, rows } = await setup();
    const lower = await replayHistory(store, rows, { scorer: historyScorer(rows), policy: { ...policy, materialMinScore: 0.4 } });
    expect(lower.pushes).toHaveLength(2);
  });

  it("re-asks the model only for candidates and caches by title", async () => {
    const { store, rows } = await setup();
    let calls = 0;
    const model: Scorer = {
      name: "llm:fake",
      async judge(_o, _s, watchlist) {
        calls++;
        const t = watchlist.trades[0]!;
        return { ...rows[1]!.verdict!, scorer: "llm:fake", consequence: 0.8, matches: [{ targetKey: `trade:${t.id}`, name: t.name, strength: 1 }] };
      },
    };
    const cache = new Map<string, JudgmentDraft>();
    const first = await replayHistory(store, rows, { scorer: historyScorer(rows, { model, cache }), policy });
    expect(calls).toBe(3); // rows 1, 3 and 5; baseline and stale items never reach a scorer that calls out
    expect(first.pushes.map((p) => p.title)).toEqual([
      "Microsoft doubles data center capex",
      "Analyst reiterates Nvidia rating",
      "Meta weighs new Louisiana campus",
    ]);
    await replayHistory(store, rows, { scorer: historyScorer(rows, { model, cache }), policy });
    expect(calls).toBe(3);
  });

  it("scopes grouped caches to evidence and prompt, and remaps event and pillar ids between scratch copies", async () => {
    const { rows } = await setup();
    const row = rows[1]!;
    let calls = 0;
    const model: Scorer = {
      name: "llm:fake", cacheVersion: "v1",
      async judge(o, _s, w, c) {
        calls++;
        return {
          ...row.verdict!, scorer: "llm:fake", material: true,
          event: { sameAs: c!.candidates!.at(-1)!.id, title: o.title, entities: [] },
          impacts: [{ tradeId: w.trades[0]!.id, pillarId: w.trades[0]!.pillars[0]!.id, effect: "majorly_supports", signalId: null, rationale: "Binding contract" }],
        };
      },
    };
    const cache = new Map<string, CachedVerdict>();
    const scorer = historyScorer(rows, { model, all: true, cache });
    const context = (eventId: string, pillarId: string) => ({ candidates: [{
      id: `other-${eventId}`, title: "Same event", type: "deal", entities: ["Alphabet"], firstSeenAt: "2026-10-01T14:00:00Z", lastSeenAt: row.fetchedAt,
      items: ["Unrelated earlier decision with the same title"], similarity: 0.8, alerted: true, impacts: [],
    }, {
      id: eventId, title: "Same event", type: "deal", entities: ["Alphabet"], firstSeenAt: row.fetchedAt, lastSeenAt: row.fetchedAt,
      items: ["Earlier report"], similarity: 0.8, alerted: true,
      impacts: [{ id: `i-${eventId}`, eventId, observationId: `o-${eventId}`, tradeId: "trade", pillarId, effect: "slightly_supports" as const, signalId: null, rationale: "Initial", createdAt: row.fetchedAt }],
    }], evidence: [{ eventId, tradeId: "trade", pillarId, effect: "slightly_supports" as const, eventTitle: "Same event", rationale: "Initial", createdAt: row.fetchedAt }] });
    const watchlist = (id: string) => ({ themes: [], entities: [], trades: [{
      id: "trade", ...PRESET_TRADES[0]!, entities: [], preset: true, createdAt: id,
      pillars: [{ id, tradeId: "trade", statement: "Compute is scarce.", signals: [], active: true, createdAt: id }],
    }] });
    const o = { id: "o", sourceId: row.sourceId, externalId: row.externalId, title: row.title, url: row.url, summary: row.summary, publishedAt: row.publishedAt, fetchedAt: row.fetchedAt, titleHash: "h", urlHash: null };
    const s = { id: row.sourceId, type: "rss", name: "Wire", config: {}, weight: 1, enabled: true, pollIntervalSeconds: null, lastRunAt: null, lastError: null, createdAt: "" };
    await scorer.judge(o, s, watchlist("old-pillar"), context("old-event", "old-pillar"));
    const cached = await scorer.judge(o, s, watchlist("new-pillar"), context("new-event", "new-pillar"));
    expect(calls).toBe(1);
    expect(cached.event!.sameAs).toBe("new-event");
    expect(cached.impacts![0]!.pillarId).toBe("new-pillar");
    const changed = context("new-event", "new-pillar");
    changed.evidence[0]!.rationale = "Different evidence";
    await scorer.judge(o, s, watchlist("new-pillar"), changed);
    expect(calls).toBe(2);
    model.cacheVersion = "v2";
    await scorer.judge(o, s, watchlist("new-pillar"), changed);
    expect(calls).toBe(3);
  });
});
