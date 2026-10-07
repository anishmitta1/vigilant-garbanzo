import { describe, expect, it } from "vitest";
import { decideAlert } from "../src/alerts.js";
import { describeTargets } from "../src/alerts.js";
import { PRESET_TRADES } from "../src/presets.js";
import { classifyEvent, heuristicScorer, matchTargets, matchTrade } from "../src/scoring/heuristic.js";
import type { Observation, Source, Trade, Watchlist } from "../src/types.js";

const watchlist: Watchlist = {
  themes: [{ id: "t1", name: "Semis", description: "", keywords: ["semiconductor", "export controls"], preset: true, createdAt: "" }],
  entities: [
    { id: "e1", name: "NVDA", kind: "ticker", aliases: ["Nvidia"], createdAt: "" },
    { id: "e2", name: "AMD", kind: "ticker", aliases: [], createdAt: "" },
  ],
  trades: [],
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

const presetTrades: Trade[] = PRESET_TRADES.map((t, i) => ({ ...t, id: `tr${i}`, preset: true, createdAt: "", entities: [], pillars: [] }));
const tradeWatchlist: Watchlist = { themes: [], entities: [], trades: presetTrades };
const tradeNamed = (name: string) => presetTrades.find((t) => t.name === name)!;

describe("event lexicon", () => {
  it.each([
    ["Fed cuts rates by 25 basis points", "rate_decision"],
    ["Gold slips as rate hike expectations build", "general"],
    ["Utility files rate hike proposal", "general"],
    ["NVIDIA & 2 momentum stocks to buy in October", "general"],
    ["Oracle agrees to buy Cerner", "m_and_a"],
    ["Opinion: how tariffs hit small shops", "general"],
    ["US imposes new tariffs on Chinese EVs", "regulation"],
  ])("%s -> %s", (title, type) => {
    expect(classifyEvent(title).type).toBe(type);
  });
});

describe("trades", () => {
  it("needs a keyword or ticker to match; signals only set direction", () => {
    const ai = tradeNamed("AI infra buildout");
    expect(matchTrade(ai, "Company raises guidance", "")).toEqual({ strength: 0 });
    expect(matchTrade(ai, "Microsoft raises capex on data center demand", "")).toMatchObject({ direction: "strengthens" });
    expect(matchTrade(ai, "Meta cuts capex, pauses data center projects", "")).toMatchObject({ direction: "weakens" });
    expect(matchTrade(ai, "nvda is lowercase", "").strength).toBe(0);
    expect(matchTrade(ai, "$NVDA slides", "").strength).toBeGreaterThan(0);
  });

  it("routes headlines to the right preset trade with direction", () => {
    const top = (title: string) => matchTargets(tradeWatchlist, title, "")[0];
    expect(top("Senate passes CLARITY Act crypto market structure bill")).toMatchObject({ name: "Crypto clarity", direction: "strengthens" });
    expect(top("Treasury yields jump as weak auction lifts term premium")).toMatchObject({ name: "Yield curve unwinding", direction: "strengthens" });
    expect(top("NRC approves restart of Palisades nuclear plant")).toMatchObject({ name: "Power & nuclear demand", direction: "strengthens" });
    expect(top("Court strikes down tariffs imposed under emergency powers")).toMatchObject({ name: "Tariffs & reshoring", direction: "weakens" });
    expect(top("Gold hits record high as central bank buying accelerates")).toMatchObject({ name: "Gold & de-dollarization", direction: "strengthens" });
  });

  it("scores a thesis signal on a tracked trade as alert-worthy", async () => {
    const j = await heuristicScorer.judge(obs("Microsoft raises capex guidance for data center buildout"), source, tradeWatchlist);
    expect(j.matches[0]).toMatchObject({ name: "AI infra buildout", direction: "strengthens" });
    expect(j.consequence).toBeGreaterThanOrEqual(0.6);
    const plain = await heuristicScorer.judge(obs("Data center tour photos"), source, tradeWatchlist);
    expect(plain.consequence).toBeLessThan(0.6);
    expect(describeTargets(j.matches)).toContain("AI infra buildout ↑ strengthening");
  });
});

describe("decideAlert", () => {
  const policy = { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.0 };
  const m = [{ targetKey: "entity:e1", name: "NVDA", strength: 1 }];

  it("alerts directly above threshold", () => {
    expect(decideAlert({ eventType: "regulation", consequence: 0.7, matches: m }, new Map(), policy)).toMatchObject({ reason: "direct" });
  });

  it("ignores unmatched or sub-floor judgments", () => {
    expect(decideAlert({ eventType: "regulation", consequence: 0.9, matches: [] }, new Map(), policy)).toBeNull();
    expect(decideAlert({ eventType: "regulation", consequence: 0.1, matches: m }, new Map([["entity:e1", 5]]), policy)).toBeNull();
  });

  it("accumulates weak signals per target", () => {
    expect(decideAlert({ eventType: "regulation", consequence: 0.4, matches: m }, new Map([["entity:e1", 0.4]]), policy)).toBeNull();
    expect(decideAlert({ eventType: "regulation", consequence: 0.4, matches: m }, new Map([["entity:e1", 0.7]]), policy)).toMatchObject({
      reason: "accumulated",
      score: 1.1,
      targetKey: "entity:e1",
    });
  });
});
