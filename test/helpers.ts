import { createClient } from "@libsql/client";
import { Store } from "../src/db.js";
import type { PipelineDeps } from "../src/pipeline.js";
import { heuristicScorer } from "../src/scoring/heuristic.js";

export async function memoryStore(): Promise<Store> {
  const store = new Store(createClient({ url: ":memory:" }));
  await store.migrate();
  return store;
}

export function fakeFetch(routes: Record<string, string | object>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const body = routes[key];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

export function deps(store: Store, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store,
    scorer: heuristicScorer,
    policy: { alertThreshold: 0.6, weakSignalFloor: 0.2, accumulationThreshold: 1.2, accumulationWindowHours: 72 },
    sourceContext: { fetch: fakeFetch({}), userAgent: "test" },
    ...overrides,
  };
}
