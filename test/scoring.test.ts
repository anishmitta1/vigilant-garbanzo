import { describe, expect, it } from "vitest";
import { decideAlert } from "../src/alerts.js";
import { classifyEvent, heuristicScorer, matchTargets } from "../src/scoring/heuristic.js";
import type { Observation, Source, Watchlist } from "../src/types.js";

const watchlist: Watchlist = {
  themes: [{ id: "t1", name: "Semis", description: "", keywords: ["semiconductor", "export controls"], preset: true, createdAt: "" }],
  entities: [
    { id: "e1", name: "NVDA", kind: "ticker", aliases: ["Nvidia"], createdAt: "" },
    { id: "e2", name: "AMD", kind: "ticker", aliases: [], createdAt: "" },
  ],
};
const source = { id: "s", name: "test", type: "rss", weight: 1 } as Source;
const obs = (title: string, summary = ""): Observation =>
  ({ id: "o", title, summary }) as Observation;

describe("heuristic scorer", () => {
  it("classifies events by lexicon priority", () => {
    expect(classifyEvent("Acme files for Chapter 11 after earnings miss").type).toBe("bankruptcy");
    expect(classifyEvent("Nvidia raises full-year guidance").type).toBe("guidance_change");
    expect(classifyEvent("Weather is nice").type).toBe("general");
  });

  it("matches tickers case-sensitively and aliases case-insensitively", () => {
    expect(matchTargets(watchlist, "amd is a word here", "").map((m) => m.targetKey)).toEqual([]);
    expect(matchTargets(watchlist, "AMD and nvidia rally", "").map((m) => m.targetKey).sort()).toEqual(["entity:e1", "entity:e2"]);
    expect(matchTargets(watchlist, "$NVDA up", "")[0]?.targetKey).toBe("entity:e1");
  });

  it("scores consequential tracked events high and irrelevant ones zero", async () => {
    const strong = await heuristicScorer.judge(obs("Nvidia raises full-year guidance"), source, watchlist);
    expect(strong.consequence).toBeGreaterThanOrEqual(0.8);
    const routine = await heuristicScorer.judge(obs("Nvidia launches new gaming card"), source, watchlist);
    expect(routine.consequence).toBeLessThan(0.6);
    const none = await heuristicScorer.judge(obs("Fed raises rates"), source, watchlist);
    expect(none.consequence).toBe(0);
  });
});

describe("decideAlert", () => {
  const policy = { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.0 };
  const m = [{ targetKey: "entity:e1", name: "NVDA", strength: 1 }];

  it("alerts directly above threshold", () => {
    expect(decideAlert({ consequence: 0.7, matches: m }, new Map(), policy)).toMatchObject({ reason: "direct" });
  });

  it("ignores unmatched or sub-floor judgments", () => {
    expect(decideAlert({ consequence: 0.9, matches: [] }, new Map(), policy)).toBeNull();
    expect(decideAlert({ consequence: 0.1, matches: m }, new Map([["entity:e1", 5]]), policy)).toBeNull();
  });

  it("accumulates weak signals per target", () => {
    expect(decideAlert({ consequence: 0.4, matches: m }, new Map([["entity:e1", 0.4]]), policy)).toBeNull();
    expect(decideAlert({ consequence: 0.4, matches: m }, new Map([["entity:e1", 0.7]]), policy)).toMatchObject({
      reason: "accumulated",
      score: 1.1,
      targetKey: "entity:e1",
    });
  });
});
