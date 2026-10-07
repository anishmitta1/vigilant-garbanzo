import { describe, expect, it } from "vitest";
import { createLlmScorer } from "../src/scoring/llm.js";
import type { Observation, Source, Watchlist } from "../src/types.js";

const watchlist: Watchlist = {
  themes: [{ id: "t1", name: "Semis", description: "", keywords: ["semiconductor"], preset: true, createdAt: "" }],
  entities: [{ id: "e1", name: "NVDA", kind: "ticker", aliases: ["Nvidia"], createdAt: "" }],
  trades: [],
};
const source = { id: "s", name: "test", type: "rss", weight: 0.5 } as Source;
const obs = { id: "o", title: "Nvidia raises full-year guidance", summary: "" } as Observation;
const llm = { apiKey: "sk-test", baseUrl: "https://llm.example/v1/", model: "test-model" };

function fakeLlm(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const completion = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }));

describe("llm scorer", () => {
  it("sends an OpenAI-compatible request and maps the response", async () => {
    const { calls, fetchImpl } = fakeLlm(() =>
      completion({
        event_type: "guidance_change",
        consequence: 0.9,
        urgency: 0.7,
        matched_targets: ["entity:e1", "entity:unknown"],
        rationale: "Raised guidance changes the thesis.",
      }),
    );
    const j = await createLlmScorer(llm, fetchImpl).judge(obs, source, watchlist);

    expect(calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toMatchObject({ model: "test-model", response_format: { type: "json_object" } });
    expect(JSON.parse(body.messages[1].content).tracked_targets.map((t: { key: string }) => t.key)).toEqual(["theme:t1", "entity:e1"]);

    expect(j).toMatchObject({
      scorer: "llm:test-model",
      eventType: "guidance_change",
      consequence: 0.9,
      urgency: 0.7,
      matches: [{ targetKey: "entity:e1", name: "NVDA", strength: 1 }],
    });
  });

  it("passes trades to the model and maps trade directions", async () => {
    const trade = { id: "tr1", name: "AI infra buildout", thesis: "Capex compounds", keywords: ["GPU"], tickers: ["NVDA"], strengthens: [], weakens: [], entities: [], pillars: [], preset: true, createdAt: "" };
    const { calls, fetchImpl } = fakeLlm(() =>
      completion({
        event_type: "guidance_change",
        consequence: 0.9,
        urgency: 0.7,
        matched_targets: ["trade:tr1", "entity:e1"],
        directions: { "trade:tr1": "strengthens", "entity:e1": "neutral" },
        rationale: "Higher guidance implies more AI capex.",
      }),
    );
    const j = await createLlmScorer(llm, fetchImpl).judge(obs, source, { ...watchlist, trades: [trade] });
    const sent = JSON.parse(JSON.parse(calls[0]?.init.body as string).messages[1].content).tracked_targets;
    expect(sent[2]).toMatchObject({ key: "trade:tr1", thesis: "Capex compounds" });
    expect(j.matches).toEqual([
      { targetKey: "trade:tr1", name: "AI infra buildout", strength: 1, direction: "strengthens" },
      { targetKey: "entity:e1", name: "NVDA", strength: 1 },
    ]);
  });

  it("maps pillar impacts and the same-event call back to real ids", async () => {
    const trade = {
      id: "tr1", name: "Power", thesis: "", keywords: [], tickers: [], strengthens: [], weakens: [], preset: true, createdAt: "",
      entities: [{ name: "Alphabet", aliases: ["Google"] }],
      pillars: [
        { id: "old", tradeId: "tr1", statement: "Retired.", signals: [], active: false, createdAt: "" },
        { id: "pil-a", tradeId: "tr1", statement: "Big buyers pay for firm power.", signals: [{ id: "1", description: "PPA", effect: "majorly_supports" as const }], active: true, createdAt: "" },
      ],
    };
    const candidate = { id: "evt-9", title: "Google–Constellation PPA", type: "deal", entities: [], firstSeenAt: "", lastSeenAt: "", items: ["a"], similarity: 0.4, alerted: true };
    const { calls, fetchImpl } = fakeLlm(() =>
      completion({
        material: true, event_type: "deal", consequence: 0.8, urgency: 0.5, matched_targets: [], rationale: "r",
        same_event: "E1", event_title: "PPA", event_entities: ["Alphabet"],
        impacts: [
          { trade: "trade:tr1", pillar: "P1", effect: "majorly_supports", signal: "P1.1", rationale: "deal" },
          { trade: "trade:tr1", pillar: null, effect: "slightly_falsifies", rationale: "other" },
          { trade: "trade:nope", pillar: "P1", effect: "majorly_supports" },
          { trade: "trade:tr1", effect: "huge" },
        ],
      }),
    );
    const evidence = [{ tradeId: "tr1", pillarId: "pil-a", effect: "slightly_supports" as const, eventTitle: "Earlier deal", createdAt: new Date().toISOString() }];
    const j = await createLlmScorer(llm, fetchImpl).judge({ ...obs, fetchedAt: new Date().toISOString() }, source, { ...watchlist, trades: [trade] }, { candidates: [candidate], evidence });
    const sent = JSON.parse(JSON.parse(calls[0]?.init.body as string).messages[1].content);
    expect(sent.tracked_targets[2].pillars).toEqual([
      { id: "P1", axiom: "Big buyers pay for firm power.", signals: [{ id: "P1.1", effect: "majorly_supports", example: "PPA" }], recent_evidence: [expect.stringContaining("slightly_supports: Earlier deal")] },
    ]);
    expect(sent.open_events[0]).toMatchObject({ id: "E1", already_alerted: true });
    expect(j.event).toEqual({ sameAs: "evt-9", title: "PPA", entities: ["Alphabet"] });
    expect(j.impacts).toEqual([
      { tradeId: "tr1", pillarId: "pil-a", effect: "majorly_supports", signalId: "1", rationale: "deal" },
      { tradeId: "tr1", pillarId: null, effect: "slightly_falsifies", signalId: null, rationale: "other" },
    ]);
    expect(j.matches).toEqual([{ targetKey: "trade:tr1", name: "Power", strength: 1, direction: "mixed" }]);
  });

  it.each([
    ["HTTP error", () => new Response("boom", { status: 500 }), "LLM HTTP 500"],
    ["non-JSON content", () => completion("not json"), "LLM fallback"],
    ["schema mismatch", () => completion({ consequence: "high" }), "LLM fallback"],
  ])("falls back to the heuristic on %s", async (_name, respond, marker) => {
    const { fetchImpl } = fakeLlm(respond);
    const j = await createLlmScorer(llm, fetchImpl).judge(obs, source, watchlist);
    expect(j.scorer).toBe("heuristic");
    expect(j.eventType).toBe("guidance_change");
    expect(j.matches.map((m) => m.targetKey)).toEqual(["entity:e1"]);
    expect(j.rationale).toContain(marker);
  });
});

describe("llm gating", () => {
  const ok = () => completion({ material: true, event_type: "guidance_change", consequence: 0.9, urgency: 0.7, matched_targets: ["entity:e1"], rationale: "r" });

  it("sends aggregator items to the model even without a keyword match", async () => {
    const { calls, fetchImpl } = fakeLlm(ok);
    const j = await createLlmScorer(llm, fetchImpl).judge({ ...obs, title: "Hyperscaler doubles data-center spend" }, { ...source, type: "google-news" }, watchlist);
    expect(calls).toHaveLength(1);
    expect(j.material).toBe(true);
  });

  it("always sends primary-source items and maps the material verdict", async () => {
    const { calls, fetchImpl } = fakeLlm(ok);
    const j = await createLlmScorer(llm, fetchImpl).judge({ ...obs, title: "Modifying the Scope of Additional Duties" }, source, watchlist);
    expect(calls).toHaveLength(1);
    expect(j.material).toBe(true);
  });

});

describe("llm request options", () => {
  const ok = () => completion({ material: false, event_type: "other", consequence: 0.1, urgency: 0.1, matched_targets: [], rationale: "r" });
  it("sends reasoning and max_tokens when configured", async () => {
    const { calls, fetchImpl } = fakeLlm(ok);
    await createLlmScorer({ ...llm, reasoning: "off", maxTokens: 800 }, fetchImpl).judge(obs, source, watchlist);
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.max_tokens).toBe(800);
  });
  it("passes an effort level through", async () => {
    const { calls, fetchImpl } = fakeLlm(ok);
    await createLlmScorer({ ...llm, reasoning: "low" }, fetchImpl).judge(obs, source, watchlist);
    expect(JSON.parse(calls[0]?.init.body as string).reasoning).toEqual({ effort: "low" });
  });
});
