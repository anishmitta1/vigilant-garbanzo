import { buildPayload, decideAlert, deliverNtfy, deliverWebhook, type AlertPolicy } from "./alerts.js";
import type { NtfyConfig } from "./config.js";
import type { Store } from "./db.js";
import { normalize } from "./preprocess.js";
import type { Scorer } from "./scoring/types.js";
import { getAdapter } from "./sources/registry.js";
import type { SourceContext } from "./sources/types.js";
import type { Alert, RawItem, Source } from "./types.js";
import { errorMessage, newId, nowIso } from "./util.js";

export interface PipelineDeps {
  store: Store;
  scorer: Scorer;
  policy: AlertPolicy & { accumulationWindowHours: number };
  sourceContext: SourceContext;
  webhookUrl?: string;
  ntfy?: NtfyConfig;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const TITLE_DEDUPE_WINDOW_MS = 7 * 24 * 3600_000;

export interface RunResult {
  sourceId: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  alerts: Alert[];
  error?: string;
}

/** source -> observation -> classify -> score consequence -> store -> alert */
export async function processItems(deps: PipelineDeps, source: Source, items: RawItem[]): Promise<RunResult> {
  const { store, scorer, policy } = deps;
  const result: RunResult = { sourceId: source.id, fetched: items.length, inserted: 0, duplicates: 0, alerts: [] };
  const watchlist = { themes: await store.listThemes(), entities: await store.listEntities() };
  const since = new Date(Date.now() - policy.accumulationWindowHours * 3600_000).toISOString();
  const titleSince =
    getAdapter(source.type).dedupeByTitle === false ? null : new Date(Date.now() - TITLE_DEDUPE_WINDOW_MS).toISOString();

  for (const item of items) {
    const draft = normalize(source.id, item);
    if (!draft) continue;
    if (await store.isDuplicate(draft, titleSince)) {
      result.duplicates++;
      continue;
    }
    const observation = await store.insertObservation(draft);
    result.inserted++;

    const judgment = { ...(await scorer.judge(observation, source, watchlist)), id: newId(), observationId: observation.id, createdAt: nowIso() };
    const priorWeakSums = new Map<string, number>();
    for (const m of judgment.matches) {
      priorWeakSums.set(m.targetKey, await store.weakSignalSum(m.targetKey, since, policy.weakSignalFloor, policy.alertThreshold));
    }
    await store.insertJudgment(judgment);

    const decision = decideAlert(judgment, priorWeakSums, policy);
    if (!decision) continue;
    const alert = await store.insertAlert({
      observationId: observation.id,
      judgmentId: judgment.id,
      reason: decision.reason,
      score: decision.score,
      targetKey: decision.targetKey,
      delivered: false,
      deliveryError: null,
    });
    deps.log?.(`ALERT [${decision.reason} ${decision.score}] ${observation.title}`);
    const payload = buildPayload(alert, observation, judgment, source);
    const channels: (() => Promise<void>)[] = [];
    const { webhookUrl, ntfy } = deps;
    if (webhookUrl) channels.push(() => deliverWebhook(webhookUrl, payload, deps.fetch));
    if (ntfy) channels.push(() => deliverNtfy(ntfy, payload, deps.fetch));
    if (channels.length > 0) {
      const errors = (await Promise.allSettled(channels.map((send) => send())))
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => errorMessage(r.reason));
      const error = errors.length > 0 ? errors.join("; ") : null;
      await store.markAlertDelivery(alert.id, error);
      alert.delivered = error === null;
      alert.deliveryError = error;
      if (error) deps.log?.(`alert delivery failed: ${error}`);
    }
    result.alerts.push(alert);
  }
  return result;
}

export async function runSource(deps: PipelineDeps, source: Source): Promise<RunResult> {
  try {
    const adapter = getAdapter(source.type);
    const config = adapter.configSchema.parse(source.config);
    const items = await adapter.fetch(config, deps.sourceContext);
    const result = await processItems(deps, source, items);
    await deps.store.recordSourceRun(source.id, null);
    deps.log?.(`${source.name}: fetched ${result.fetched}, new ${result.inserted}, alerts ${result.alerts.length}`);
    return result;
  } catch (err) {
    const error = errorMessage(err);
    await deps.store.recordSourceRun(source.id, error);
    deps.log?.(`${source.name}: error ${error}`);
    return { sourceId: source.id, fetched: 0, inserted: 0, duplicates: 0, alerts: [], error };
  }
}

export function isDue(source: Source, defaultIntervalSeconds: number, now = Date.now()): boolean {
  if (!source.enabled || source.type === "push") return false;
  if (!source.lastRunAt) return true;
  const interval = (source.pollIntervalSeconds ?? defaultIntervalSeconds) * 1000;
  return now - Date.parse(source.lastRunAt) >= interval;
}

export async function runDueSources(deps: PipelineDeps, defaultIntervalSeconds: number): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const source of await deps.store.listSources()) {
    if (isDue(source, defaultIntervalSeconds)) results.push(await runSource(deps, source));
  }
  return results;
}
