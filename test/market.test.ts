import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/digest.js";
import { basketDays, checkMarket, fetchCloses, inSession, summarizeMarket, type Closes } from "../src/market.js";
import type { Trade } from "../src/types.js";

const dates = Array.from({ length: 45 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
const BIG = 44; // 2026-10-15

function series(start: number, bigMove: number): Closes {
  const out: Closes = new Map();
  let c = start;
  dates.forEach((d, i) => {
    if (i > 0) c *= i === BIG ? 1 + bigMove : i % 2 ? 1.005 : 0.995;
    out.set(d, c);
  });
  return out;
}

const trade = { id: "t1", name: "AI infra buildout", tickers: ["A", "B", "GONE"] } as Trade;
const prices = { closes: new Map([["A", series(100, 0.05)], ["B", series(50, -0.04)]]), missing: ["GONE"] };

describe("market check", () => {
  it("flags a basket move far above its typical day, direction-agnostic", () => {
    const days = basketDays([...prices.closes.values()]);
    const big = days.filter((d) => (d.ratio ?? 0) >= 2.5);
    expect(big.map((d) => d.date)).toEqual(["2026-10-15"]);
    expect(big[0]!.move).toBeCloseTo(0.045, 3);
    expect(days[0]!.baseline).toBeNull();
  });

  it("assigns pushes to the session they could have called", () => {
    expect(inSession("2026-10-15T18:00:00Z", "2026-10-14", "2026-10-15")).toBe(true); // 14:00 ET
    expect(inSession("2026-10-14T20:30:00Z", "2026-10-14", "2026-10-15")).toBe(true); // 16:30 ET the day before
    expect(inSession("2026-10-15T20:30:00Z", "2026-10-14", "2026-10-15")).toBe(false); // after the close
  });

  it("marks big days caught or missed and counts quiet-day pushes", () => {
    const pushes = [
      { at: "2026-10-15T15:00:00Z", title: "Nvidia guides up", tradeIds: ["t1"] },
      { at: "2026-10-10T15:00:00Z", title: "Routine capex note", tradeIds: ["t1"] },
      { at: "2026-10-10T15:00:00Z", title: "Other trade", tradeIds: ["t2"] },
    ];
    const check = checkMarket([trade], prices, pushes, new Date("2026-10-01T12:00:00Z"), new Date("2026-10-15T23:00:00Z"));
    expect(check.days.find((d) => d.big)?.caught.map((p) => p.title)).toEqual(["Nvidia guides up"]);
    expect(check.missing).toEqual(["GONE"]);
    expect(summarizeMarket(check)).toEqual({ sessions: 15, bigDays: 1, caught: 1, quietPushes: 1, labelledPushes: 2 });
  });

  it("parses Yahoo closes and drops today's bar until after the close", async () => {
    const body = {
      chart: {
        result: [
          {
            timestamp: [Date.parse("2026-10-14T13:30:00Z") / 1000, Date.parse("2026-10-15T13:30:00Z") / 1000, Date.parse("2026-10-16T13:30:00Z") / 1000],
            indicators: { quote: [{ close: [10, null, 12] }], adjclose: [{ adjclose: [9.9, null, 11.9] }] },
          },
        ],
      },
    };
    const fake = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const open = await fetchCloses("X", new Date("2026-10-01"), new Date("2026-10-16T17:00:00Z"), fake);
    expect([...open.entries()]).toEqual([["2026-10-14", 9.9]]);
    const closed = await fetchCloses("X", new Date("2026-10-01"), new Date("2026-10-16T21:00:00Z"), fake);
    expect(closed.get("2026-10-16")).toBe(11.9);
  });

  it("adds caught/missed lines and the 30-day scorecard to the digest", () => {
    const check = checkMarket([trade], prices, [], new Date("2026-10-15T00:00:00Z"), new Date("2026-10-15T23:00:00Z"));
    const day = check.days.find((d) => d.big)!;
    const digest = buildDigest([], {
      dateLabel: "Oct 15",
      failingSources: [],
      market: { today: [{ day }], session: true, last30: summarizeMarket(check), missing: [] },
    });
    expect(digest.body).toContain("AI infra buildout 9.0× — missed");
    expect(digest.body).toContain("missed · nothing matched");
    expect(digest.body).toContain("30d: caught 0/1 big days");
  });
});
