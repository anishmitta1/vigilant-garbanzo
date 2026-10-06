import { describe, expect, it } from "vitest";
import { createLlmScorer } from "../src/scoring/llm.js";
import type { Observation, Source, Watchlist } from "../src/types.js";

const watchlist: Watchlist = {
  themes: [{ id: "t1", name: "Semis", description: "", keywords: ["semiconductor"], preset: true, createdAt: "" }],
  entities: [{ id: "e1", name: "NVDA", kind: "ticker", aliases: ["Nvidia"], createdAt: "" }],
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
      consequence: 0.45,
      urgency: 0.7,
      matches: [{ targetKey: "entity:e1", name: "NVDA", strength: 1 }],
    });
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
