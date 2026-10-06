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
    // earnings events with the ticker only in the summary: consequence 0.35 each
    const titles = ["Chip earnings preview A", "Chip earnings preview B", "Chip earnings preview C", "Chip earnings preview D"];
    const results = [];
    for (const [i, title] of titles.entries()) {
      results.push(await processItems(d, source, [{ externalId: String(i), title, summary: "What to expect from Nvidia" }]));
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

    const trade = await app.inject({ method: "POST", url: "/trades", payload: { name: "Gold", keywords: ["gold"], strengthens: ["record high"] } });
    expect(trade.statusCode).toBe(201);
    expect((await app.inject({ url: "/trades" })).json()).toMatchObject([{ name: "Gold", tickers: [], weakens: [] }]);
    expect((await app.inject({ method: "POST", url: "/trades", payload: { keywords: ["x"] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/trades/${trade.json().id}` })).statusCode).toBe(204);
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

describe("ntfy delivery", () => {
  it("pushes alerts to ntfy alongside the webhook and records failures", async () => {
    const { store, source } = await setup();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: url.startsWith("https://hooks") ? 500 : 200 });
    }) as unknown as typeof fetch;
    const d = deps(store, {
      webhookUrl: "https://hooks.example.com/x",
      ntfy: { url: "https://ntfy.example/", topic: "mimir-test", token: "tk" },
      fetch: fetchImpl,
    });
    const result = await processItems(d, source, [{ externalId: "1", title: "Nvidia raises full-year guidance", url: "https://a.com/1" }]);

    const push = calls.find((c) => c.url === "https://ntfy.example");
    expect((push?.init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
    expect(JSON.parse(String(push?.init.body))).toMatchObject({
      topic: "mimir-test",
      title: "Nvidia raises full-year guidance",
      priority: 5,
      click: "https://a.com/1",
    });
    expect(result.alerts[0]).toMatchObject({ delivered: false, deliveryError: "Webhook HTTP 500" });
  });
});

describe("bark delivery", () => {
  it("pushes alerts to the Bark device URL", async () => {
    const { store, source } = await setup();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: 200, message: "success" }));
    }) as unknown as typeof fetch;
    const d = deps(store, { barkUrl: "https://api.day.app/KEY/", fetch: fetchImpl });
    const result = await processItems(d, source, [{ externalId: "1", title: "Nvidia raises full-year guidance", url: "https://a.com/1" }]);

    expect(calls[0]?.url).toBe("https://api.day.app/KEY");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      title: "Nvidia raises full-year guidance",
      level: "timeSensitive",
      group: "Mimir",
      url: "https://a.com/1",
    });
    expect(result.alerts[0]).toMatchObject({ delivered: true, deliveryError: null });
  });
});

describe("slack delivery", () => {
  it("posts trade alerts with direction to a Slack webhook", async () => {
    const store = await memoryStore();
    const source = await store.createSource({ type: "push", name: "test", config: {} });
    await store.createTrade({ name: "AI infra buildout", thesis: "", keywords: ["data center"], tickers: ["MSFT"], strengthens: ["raises capex"], weakens: [] });
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const d = deps(store, { slackWebhookUrl: "https://hooks.slack.com/services/T/B/X", fetch: fetchImpl });
    const result = await processItems(d, source, [{ externalId: "1", title: "MSFT raises capex for data center & power", url: "https://a.com/1" }]);

    expect(result.alerts[0]).toMatchObject({ targetKey: expect.stringMatching(/^trade:/), delivered: true });
    const text = JSON.parse(String(calls[0]?.init.body)).text as string;
    expect(text).toContain("<https://a.com/1|MSFT raises capex for data center &amp; power>");
    expect(text).toContain("AI infra buildout ↑ strengthening");
  });
});

describe("noise controls", () => {
  const rss = (titles: string[]) =>
    `<?xml version="1.0"?><rss><channel>${titles
      .map((t, i) => `<item><title>${t}</title><link>https://n.com/${encodeURIComponent(t)}</link><guid>${t}</guid><pubDate>${new Date(Date.now() - i * 60_000).toUTCString()}</pubDate></item>`)
      .join("")}</channel></rss>`;

  it("treats a source's first poll as a silent baseline", async () => {
    const store = await memoryStore();
    await store.createEntity({ name: "NVDA", kind: "ticker", aliases: ["Nvidia"] });
    const source = await store.createSource({ type: "rss", name: "feed", config: { url: "https://n.com/feed" } });
    const first = await runSource(deps(store, { sourceContext: { fetch: fakeFetch({ "https://n.com": rss(["Nvidia raises full-year guidance"]) }), userAgent: "t" } }), source);
    expect(first).toMatchObject({ inserted: 1, alerts: [] });
    const second = await runSource(
      deps(store, { sourceContext: { fetch: fakeFetch({ "https://n.com": rss(["Nvidia cuts full-year guidance", "Nvidia raises full-year guidance"]) }), userAgent: "t" } }),
      source,
    );
    expect(second).toMatchObject({ inserted: 1 });
    expect(second.alerts).toHaveLength(1);
  });

  it("holds repeat alerts on a target during the cooldown unless very strong", async () => {
    const { store, source } = await setup();
    const policy = { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.2, accumulationWindowHours: 72, alertCooldownHours: 6, cooldownBypassScore: 0.95 };
    const d = deps(store, { policy });
    const result = await processItems(d, source, [
      { externalId: "1", title: "Nvidia raises full-year guidance" },
      { externalId: "2", title: "Nvidia cuts full-year guidance again" },
      { externalId: "3", title: "Nvidia files for Chapter 11 bankruptcy" },
    ]);
    expect(result.inserted).toBe(3);
    expect(result.alerts.map((a) => a.score)).toEqual([0.85, 0.95]);
  });
});

describe("stale items", () => {
  it("stores but does not alert on items older than maxAlertAgeHours", async () => {
    const { store, source } = await setup();
    const d = deps(store, { policy: { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.2, accumulationWindowHours: 72, maxAlertAgeHours: 48 } });
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const result = await processItems(d, source, [
      { externalId: "old", title: "Nvidia raises full-year guidance", url: "https://a.com/old", publishedAt: old },
      { externalId: "new", title: "Nvidia cuts full-year guidance", url: "https://a.com/new", publishedAt: new Date().toISOString() },
    ]);
    expect(result.inserted).toBe(2);
    expect(result.alerts.map((a) => a.observationId)).toHaveLength(1);
    expect((await store.listAlerts(10)).length).toBe(1);
  });
});
