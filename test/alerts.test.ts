import { describe, expect, it } from "vitest";
import { buildPayload, deliverBark, directionLine, publishedLine, splitOutlet } from "../src/alerts.js";
import type { Judgment, TargetMatch } from "../src/types.js";
import { newId } from "../src/util.js";
import { memoryStore } from "./helpers.js";

const ai: TargetMatch = { targetKey: "trade:1", name: "AI infra buildout", strength: 1, direction: "strengthens" };
const power: TargetMatch = { targetKey: "trade:2", name: "Power & nuclear demand", strength: 1, direction: "weakens" };
const theme: TargetMatch = { targetKey: "theme:1", name: "AI infrastructure", strength: 1 };

describe("alert text", () => {
  it("lists trades with direction and hides themes when a trade matched", () => {
    expect(directionLine([ai, theme, power])).toBe("▲ AI infra buildout   ▼ Power & nuclear demand");
    expect(directionLine([theme])).toBe("• AI infrastructure");
  });

  it("names the real outlet for Google News items only", () => {
    const gn = { name: "Google News: AI infra", type: "google-news" };
    expect(splitOutlet("SpaceX Seeking to Raise $40 Billion to Buy Nvidia Chips, FT Says - Bloomberg.com", gn)).toEqual({
      title: "SpaceX Seeking to Raise $40 Billion to Buy Nvidia Chips, FT Says",
      outlet: "Bloomberg.com",
    });
    const rss = { name: "Federal Reserve press releases", type: "rss" };
    expect(splitOutlet("Fed - statement", rss)).toEqual({ title: "Fed - statement", outlet: "Federal Reserve press releases" });
  });

  it("shows publish time in ET and how long ago", () => {
    const now = new Date("2026-10-06T23:06:55Z");
    expect(publishedLine("2026-10-06T22:57:42Z", now)).toBe("6:57 PM ET (9m ago)");
    expect(publishedLine("2026-10-05T20:00:00Z", now)).toBe("4:00 PM ET (27h ago)");
    expect(publishedLine(null, now)).toBeNull();
  });

  it("formats the Bark push: clean headline, direction subtitle, why + outlet footer", async () => {
    const store = await memoryStore();
    const source = await store.createSource({ type: "google-news", name: "Google News: AI infra", config: { query: "x" } });
    const observation = await store.insertObservation({
      sourceId: source.id,
      externalId: "1",
      url: "https://news.google.com/x",
      title: "SpaceX Seeking to Raise $40 Billion to Buy Nvidia Chips, FT Says - Bloomberg.com",
      summary: "",
      publishedAt: "2026-10-06T22:57:42Z",
      urlHash: null,
      titleHash: "h",
    });
    const judgment: Judgment = {
      id: newId(),
      observationId: observation.id,
      scorer: "llm:test",
      eventType: "deal",
      consequence: 0.55,
      urgency: 0.6,
      matches: [ai, theme],
      rationale: "A $40B raise to buy Nvidia chips adds a large new GPU buyer; reported plan, not a closed deal.",
      material: true,
      createdAt: "2026-10-06T23:06:55Z",
    };
    await store.insertJudgment(judgment);
    const alert = await store.insertAlert({
      observationId: observation.id,
      judgmentId: judgment.id,
      reason: "direct",
      score: 0.55,
      targetKey: "trade:1",
      delivered: false,
      deliveryError: null,
    });
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await deliverBark("https://api.day.app/KEY", buildPayload(alert, observation, judgment, source), fetchImpl, new Date("2026-10-06T23:06:55Z"));
    expect(body).toMatchObject({
      title: "SpaceX Seeking to Raise $40 Billion to Buy Nvidia Chips, FT Says",
      subtitle: "▲ AI infra buildout",
      body: "A $40B raise to buy Nvidia chips adds a large new GPU buyer; reported plan, not a closed deal.\nBloomberg.com · 6:57 PM ET (9m ago)",
      group: "Mimir",
      url: "https://news.google.com/x",
    });
  });
});
