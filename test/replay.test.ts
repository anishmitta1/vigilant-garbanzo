import { describe, expect, it } from "vitest";
import { PRESET_TRADES } from "../src/presets.js";
import { historyScorer, replayHistory, type HistoryRow } from "../src/replay.js";
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
});
