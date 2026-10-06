import { describe, expect, it } from "vitest";
import { isDue, processItems, runSource } from "../src/pipeline.js";
import { buildServer } from "../src/server.js";
import type { Source } from "../src/types.js";
import { deps, fakeFetch, memoryStore } from "./helpers.js";

async function setup() {
  const store = await memoryStore();
  await store.createEntity({ name: "NVDA", kind: "ticker", aliases: ["Nvidia"] });
  const source = await store.createSource({ type: "push", name: "test", config: {} });
  return { store, source };
}

describe("pipeline", () => {
  it("stores observations, dedupes, judges, and alerts via webhook", async () => {
    const { store, source } = await setup();
    const hooks: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      hooks.push(JSON.parse(String(init?.body)));
      return new Response("ok");
    }) as typeof fetch;
    const d = deps(store, { webhookUrl: "https://hooks.example.com/x", fetch: fetchImpl });

    const items = [
      { externalId: "1", title: "Nvidia raises full-year guidance", url: "https://a.com/1" },
      { externalId: "2", title: "Nvidia raises full-year guidance - Reuters", url: "https://b.com/2" },
      { externalId: "3", title: "Unrelated story", url: "https://a.com/3" },
    ];
    const result = await processItems(d, source, items);
    expect(result).toMatchObject({ fetched: 3, inserted: 2, duplicates: 1 });
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ reason: "direct", delivered: true });
    expect(hooks[0]).toMatchObject({ type: "mimir.alert", observation: { title: "Nvidia raises full-year guidance" } });

    const again = await processItems(d, source, items);
    expect(again).toMatchObject({ inserted: 0, duplicates: 3 });

    const alerts = await store.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.judgment.eventType).toBe("guidance_change");
  });

  it("accumulates weak signals into one alert and then resets", async () => {
    const { store, source } = await setup();
    const d = deps(store, { policy: { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.0, accumulationWindowHours: 72 } });
    // product events: consequence 0.35 each
    const titles = ["Nvidia unveils chip A", "Nvidia unveils chip B", "Nvidia unveils chip C", "Nvidia unveils chip D"];
    const results = [];
    for (const [i, title] of titles.entries()) {
      results.push(await processItems(d, source, [{ externalId: String(i), title }]));
    }
    expect(results.map((r) => r.alerts.length)).toEqual([0, 0, 1, 0]);
    expect(results[2]?.alerts[0]).toMatchObject({ reason: "accumulated" });
  });

  it("records source errors without throwing", async () => {
    const store = await memoryStore();
    const source = await store.createSource({ type: "rss", name: "broken", config: { url: "https://down.example.com/feed" } });
    const result = await runSource(deps(store, { sourceContext: { fetch: fakeFetch({}), userAgent: "t" } }), source);
    expect(result.error).toMatch(/HTTP 404/);
    expect((await store.getSource(source.id))?.lastError).toMatch(/HTTP 404/);
  });

  it("schedules sources by interval", () => {
    const base = { enabled: true, type: "rss", pollIntervalSeconds: null, lastRunAt: null } as Source;
    expect(isDue(base, 60)).toBe(true);
    expect(isDue({ ...base, lastRunAt: new Date().toISOString() }, 60)).toBe(false);
    expect(isDue({ ...base, lastRunAt: new Date(Date.now() - 61_000).toISOString() }, 60)).toBe(true);
    expect(isDue({ ...base, type: "push" }, 60)).toBe(false);
    expect(isDue({ ...base, enabled: false }, 60)).toBe(false);
  });
});

describe("http api", () => {
  it("manages themes/entities/sources and ingests items", async () => {
    const store = await memoryStore();
    const app = buildServer(store, deps(store));

    const theme = await app.inject({ method: "POST", url: "/themes", payload: { name: "Semis", keywords: ["semiconductor", "export controls"] } });
    expect(theme.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/entities", payload: { name: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/sources", payload: { type: "rss", name: "x", config: {} } })).statusCode).toBe(400);
    const src = await app.inject({ method: "POST", url: "/sources", payload: { type: "sec-edgar", name: "edgar" } });
    expect(src.json()).toMatchObject({ config: { forms: ["8-K"], count: 40 } });

    const ingest = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { items: [{ title: "US tightens semiconductor export controls", url: "https://a.com/x" }] },
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json()).toMatchObject({ inserted: 1 });
    expect((await app.inject({ url: "/alerts" })).json()).toHaveLength(1);
    expect((await app.inject({ url: "/observations?limit=5" })).json()[0].judgment.eventType).toBe("regulation");
    expect((await app.inject({ method: "DELETE", url: `/themes/${theme.json().id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/themes/missing" })).statusCode).toBe(404);
  });
});

describe("dedupe", () => {
  it("does not title-dedupe sources that reuse titles (EDGAR)", async () => {
    const store = await memoryStore();
    const edgar = await store.createSource({ type: "sec-edgar", name: "edgar", config: {} });
    const items = [1, 2, 3].map((n) => ({ externalId: `acc-${n}`, title: "8-K - Current report", url: `https://sec.gov/${n}` }));
    expect(await processItems(deps(store), edgar, items)).toMatchObject({ inserted: 3, duplicates: 0 });
  });
});
