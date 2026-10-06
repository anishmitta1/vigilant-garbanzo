import { describe, expect, it } from "vitest";
import { decideAlert } from "../src/alerts.js";

const policy = { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.2, materialMinScore: 0.5 };
const matches = [{ targetKey: "trade:t1", name: "Crypto clarity", strength: 1, direction: "strengthens" as const }];
const base = { matches, eventType: "regulatory_action" };

describe("material verdict gating", () => {
  it("alerts directly on a material verdict above the floor, even below the score threshold", () => {
    expect(decideAlert({ ...base, consequence: 0.55, material: true }, new Map(), policy)).toEqual({
      reason: "direct",
      score: 0.55,
      targetKey: "trade:t1",
      material: true,
    });
  });

  it("never alerts or accumulates a non-material verdict, however high the score", () => {
    expect(decideAlert({ ...base, consequence: 0.95, material: false }, new Map(), policy)).toBeNull();
    expect(decideAlert({ ...base, consequence: 0.4, material: false }, new Map([["trade:t1", 5]]), policy)).toBeNull();
  });

  it("drops material verdicts below the floor", () => {
    expect(decideAlert({ ...base, consequence: 0.3, material: true }, new Map(), policy)).toBeNull();
  });
});
