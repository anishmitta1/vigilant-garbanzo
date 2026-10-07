import { describe, expect, it } from "vitest";
import { processItems } from "../src/pipeline.js";
import { heuristicScorer } from "../src/scoring/heuristic.js";
import { createLlmTriage, type Triage } from "../src/scoring/triage.js";
import type { Scorer } from "../src/scoring/types.js";
import type { Watchlist } from "../src/types.js";
import { deps, memoryStore } from "./helpers.js";

const llm = { apiKey: "k", baseUrl: "https://llm.example.com/v1", model: "m" };
const watchlist: Watchlist = { themes: [], entities: [], trades: [] };
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Release ${i + 1}`, summary: "" }));

describe("llm triage", () => {
  it("keeps the numbered items the model returns, one call per 50", async () => {
    const calls: { items: unknown[] }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(JSON.parse(String(init?.body)).messages[1].content));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keep: [2, "50"] }) } }] }));
    }) as typeof fetch;
    const keep = await createLlmTriage(llm, fetchImpl)(items(60), watchlist);
    expect(calls.map((c) => c.items.length)).toEqual([50, 10]);
    expect(keep.flatMap((k, i) => (k ? [i + 1] : []))).toEqual([2, 50, 52]);
  });

  it("fails open so a model error never drops items", async () => {
    const fetchImpl = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    expect(await createLlmTriage(llm, fetchImpl)(items(3), watchlist)).toEqual([true, true, true]);
  });
});

describe("triaged sources", () => {
  it("fully judges only kept items and screens each new item once", async () => {
    const store = await memoryStore();
    const source = await store.createSource({ type: "rss", name: "wire", config: { url: "https://w.com/feed", triage: true } });
    const screened: string[][] = [];
    const triage: Triage = async (batch) => {
      screened.push(batch.map((b) => b.title));
      return batch.map((b) => b.title.includes("Nvidia"));
    };
    const judged: string[] = [];
    const scorer: Scorer = { name: "spy", judge: async (o, s, w, c) => (judged.push(o.title), heuristicScorer.judge(o, s, w, c)) };
    const d = deps(store, { scorer, triage });
    const wire = [
      { externalId: "1", title: "Nvidia signs supply deal", url: "https://w.com/1" },
      { externalId: "2", title: "Acme Pet Foods names new CFO", url: "https://w.com/2" },
    ];
    expect(await processItems(d, source, wire, { triage: true })).toMatchObject({ inserted: 2 });
    expect(judged).toEqual(["Nvidia signs supply deal"]);
    expect(await processItems(d, source, wire, { triage: true })).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(screened).toEqual([["Nvidia signs supply deal", "Acme Pet Foods names new CFO"]]);
  });

  it("skips triage on a source's first poll, which never calls the model", async () => {
    const store = await memoryStore();
    const source = await store.createSource({ type: "rss", name: "wire", config: { url: "https://w.com/feed", triage: true } });
    let calls = 0;
    const triage: Triage = async (batch) => (calls++, batch.map(() => false));
    await processItems(deps(store, { triage }), source, [{ externalId: "1", title: "Old release" }], { triage: true, baseline: true });
    expect(calls).toBe(0);
  });
});
