import { loadConfig, type Config } from "./config.js";
import { openStore, type Store } from "./db.js";
import { runDueSources, type PipelineDeps } from "./pipeline.js";
import { DEFAULT_SOURCES, PRESET_THEMES } from "./presets.js";
import { heuristicScorer } from "./scoring/heuristic.js";
import { createLlmScorer } from "./scoring/llm.js";
import { buildServer } from "./server.js";

const TICK_MS = 60_000;

async function seed(store: Store): Promise<void> {
  if ((await store.listThemes()).length === 0) {
    for (const t of PRESET_THEMES) await store.createTheme({ ...t, preset: true });
  }
  if ((await store.listSources()).length === 0) {
    for (const s of DEFAULT_SOURCES) await store.createSource(s);
  }
}

export function createDeps(config: Config, store: Store): PipelineDeps {
  return {
    store,
    scorer: config.llm ? createLlmScorer(config.llm) : heuristicScorer,
    policy: config,
    sourceContext: { fetch, userAgent: config.userAgent },
    webhookUrl: config.alertWebhookUrl,
    log: (msg) => console.log(`[mimir] ${msg}`),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await openStore(config.databaseUrl, config.tursoAuthToken);
  if (config.seedDefaults) await seed(store);
  const deps = createDeps(config, store);

  const app = buildServer(store, deps);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  deps.log?.(`listening on :${config.port} (db ${config.databaseUrl.split("?")[0]}, scorer ${deps.scorer.name})`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueSources(deps, config.pollIntervalSeconds);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), TICK_MS).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
