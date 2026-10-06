import { describe, expect, it } from "vitest";
import { buildDigest, digestDue, localParts, maybeSendDigest } from "../src/digest.js";
import type { Judgment } from "../src/types.js";
import { memoryStore } from "./helpers.js";

const LA = { time: "16:00", timeZone: "America/Los_Angeles" };

describe("digest schedule", () => {
  it("converts to local time across DST", () => {
    expect(localParts(new Date("2026-10-06T23:00:00Z"), LA.timeZone)).toEqual({ date: "2026-10-06", time: "16:00" });
    expect(localParts(new Date("2026-12-02T00:00:00Z"), LA.timeZone)).toEqual({ date: "2026-12-01", time: "16:00" });
  });

  it("is due once per local day at or after the scheduled time", () => {
    const at = (iso: string) => new Date(iso);
    expect(digestDue(at("2026-10-06T22:59:00Z"), LA, null)).toBe(false);
    expect(digestDue(at("2026-10-06T23:00:00Z"), LA, null)).toBe(true);
    expect(digestDue(at("2026-10-07T03:00:00Z"), LA, "2026-10-06T23:00:00Z")).toBe(false);
    expect(digestDue(at("2026-10-07T23:01:00Z"), LA, "2026-10-06T23:00:00Z")).toBe(true);
  });
});

describe("digest content", () => {
  it("caps the body for a single push", () => {
    const judgment = (i: number): Judgment => ({
      id: `j${i}`,
      observationId: `o${i}`,
      scorer: "llm:x",
      eventType: "policy",
      consequence: 0.4,
      urgency: 0.2,
      matches: [{ targetKey: "trade:t", name: "Crypto clarity", strength: 1 }],
      rationale: "r".repeat(400),
      material: false,
      createdAt: "2026-10-06T20:00:00.000Z",
    });
    const rows = Array.from({ length: 50 }, (_, i) => ({
      judgment: judgment(i),
      title: "t".repeat(300),
      url: null,
      publishedAt: null,
      sourceName: "s",
      alerted: i % 2 === 0,
    }));
    const digest = buildDigest(rows, { dateLabel: "Oct 6", failingSources: [] });
    expect(digest.body.length).toBeLessThanOrEqual(2500);
    expect(digest.subtitle).toBe("25 alerts · 25 near-misses");
  });
});

describe("maybeSendDigest", () => {
  it("sends alerts and near-misses once a day, each covering the time since the last", async () => {
    const store = await memoryStore();
    const source = await store.createSource({ type: "push", name: "Fed", config: {} });
    const add = async (n: number, title: string, j: Partial<Judgment>) => {
      const obs = await store.insertObservation({
        sourceId: source.id,
        externalId: String(n),
        url: null,
        title,
        summary: "",
        publishedAt: null,
        urlHash: null,
        titleHash: `h${n}`,
      });
      const judgment: Judgment = {
        id: `j${n}`,
        observationId: obs.id,
        scorer: "llm:deepseek",
        eventType: "policy",
        consequence: 0,
        urgency: 0,
        matches: [],
        rationale: "",
        createdAt: "2026-10-06T20:00:00.000Z",
        ...j,
      };
      await store.insertJudgment(judgment);
      return judgment;
    };
    const trade = [{ targetKey: "trade:y", name: "Yield curve unwinding", strength: 1, direction: "strengthens" as const }];
    const hit = await add(1, "Fed cuts rates 50bp", { consequence: 0.9, material: true, matches: trade });
    await store.insertAlert({
      observationId: hit.observationId,
      judgmentId: hit.id,
      reason: "direct",
      score: 0.9,
      targetKey: "trade:y",
      delivered: true,
      deliveryError: null,
    });
    await add(2, "Fed governor speaks at conference", { consequence: 0.4, material: false, matches: trade, rationale: "Routine speech." });
    await add(3, "Unrelated story", { consequence: 0.1, material: false });
    await add(4, "Old NRC backlog item", { consequence: 0.8, material: true, matches: trade, held: "baseline" });
    await add(5, "Fed cuts 50bp - Reuters", { consequence: 0.9, material: true, matches: trade, held: "same_story" });
    await add(6, "Treasury refunding update", {
      scorer: "heuristic",
      consequence: 0.35,
      matches: trade,
      rationale: "keyword match (LLM daily cap reached)",
    });

    const pushes: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      pushes.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    }) as typeof fetch;
    const d = { store, barkUrl: "https://bark.example/key", fetch: fetchImpl };

    expect(await maybeSendDigest(d, LA, new Date("2026-10-06T22:00:00Z"))).toBe(false);
    expect(await maybeSendDigest(d, LA, new Date("2026-10-06T23:05:00Z"))).toBe(true);
    expect(await maybeSendDigest(d, LA, new Date("2026-10-07T02:00:00Z"))).toBe(false);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ title: "Mimir daily digest · Oct 6", subtitle: "1 alert · 3 near-misses", group: "Mimir digest" });
    expect(pushes[0]?.body).toContain("• Fed cuts rates 50bp — Yield curve unwinding ↑ strengthening");
    expect(pushes[0]?.body).toContain("0.40 Fed governor speaks at conference [not material]");
    expect(pushes[0]?.body).toContain("Fed cuts 50bp - Reuters [same story already alerted]");
    expect(pushes[0]?.body).toContain("Treasury refunding update [no model: daily cap]");
    expect(pushes[0]?.body).toContain("Read 6 items · 5 model calls");
    expect(pushes[0]?.body).toContain("⚠ 1 items missed the model");
    expect(pushes[0]?.body).not.toContain("Unrelated");
    expect(pushes[0]?.body).not.toContain("Old NRC backlog");

    expect(await maybeSendDigest(d, LA, new Date("2026-10-07T23:05:00Z"))).toBe(true);
    expect(pushes[1]?.body).toMatch(/^No alerts\.\n\nRead 0 items/);
  });
});
