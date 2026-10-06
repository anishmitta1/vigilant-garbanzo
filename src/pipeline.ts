import {
  buildPayload,
  decideAlert,
  deliverBark,
  deliverNtfy,
  deliverSlack,
  deliverWebhook,
  type AlertDecision,
  type AlertPolicy,
} from "./alerts.js";
import type { NtfyConfig } from "./config.js";
import type { Store } from "./db.js";
import { normalize, sameStory } from "./preprocess.js";
import { heuristicScorer } from "./scoring/heuristic.js";
import type { Scorer } from "./scoring/types.js";
import { getAdapter } from "./sources/registry.js";
import type { SourceContext } from "./sources/types.js";
import type { Alert, HeldReason, RawItem, Source } from "./types.js";
import { errorMessage, newId, nowIso } from "./util.js";

export interface PipelineDeps {
  store: Store;
  scorer: Scorer;
  policy: AlertPolicy & {
    accumulationWindowHours: number;
    maxAlertAgeHours?: number;
    /** After an alert on a target, hold further alerts on it this long... */
    alertCooldownHours?: number;
    /** ...unless a direct alert scores at least this. */
    cooldownBypassScore?: number;
    /** Skip alerts for a story already alerted on (any outlet) within this window. */
    storyWindowHours?: number;
  };
  sourceContext: SourceContext;
  webhookUrl?: string;
  ntfy?: NtfyConfig;
  barkUrl?: string;
  /** Bark is the "drop everything" channel: only direct alerts at or above this score. */
  barkMinScore?: number;
  /** With an LLM configured, Bark also requires an explicit material=true verdict (heuristic fallbacks never push). */
  barkRequiresMaterial?: boolean;
  slackWebhookUrl?: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const TITLE_DEDUPE_WINDOW_MS = 7 * 24 * 3600_000;
/** Signal timestamp for baseline items: before any accumulation window, so they never accumulate. */
const BASELINE_SIGNAL_AT = new Date(0).toISOString();

export interface RunResult {
  sourceId: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  alerts: Alert[];
  error?: string;
}

/** source -> observation -> classify -> score consequence -> store -> alert */
export async function processItems(
  deps: PipelineDeps,
  source: Source,
  items: RawItem[],
  opts: { baseline?: boolean } = {},
): Promise<RunResult> {
  const { store, scorer, policy } = deps;
  const result: RunResult = { sourceId: source.id, fetched: items.length, inserted: 0, duplicates: 0, alerts: [] };
  const watchlist = {
    themes: await store.listThemes(),
    entities: await store.listEntities(),
    trades: await store.listTrades(),
  };
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

    // Backlog (e.g. a feed's history on first poll) and a new source's first batch are stored and scored
    // but never alert or accumulate, so they get the free heuristic rather than a model call.
    const held: HeldReason | undefined = isStale(observation.publishedAt, policy.maxAlertAgeHours) ? "stale" : opts.baseline ? "baseline" : undefined;
    const scored = await (held ? heuristicScorer : scorer).judge(observation, source, watchlist);
    const judgment = { ...scored, ...(held ? { held } : {}), id: newId(), observationId: observation.id, createdAt: nowIso() };
    if (held) {
      await store.insertJudgment(judgment, held === "stale" ? new Date(observation.publishedAt!).toISOString() : BASELINE_SIGNAL_AT);
      continue;
    }
    const priorWeakSums = new Map<string, number>();
    for (const m of judgment.matches) {
      priorWeakSums.set(m.targetKey, await store.weakSignalSum(m.targetKey, since, policy.weakSignalFloor, policy.alertThreshold));
    }
    await store.insertJudgment(judgment);

    const decision = decideAlert(judgment, priorWeakSums, policy);
    if (!decision) continue;
    if (await coolingDown(store, decision, policy)) {
      await store.markHeld(judgment.id, "cooldown");
      continue;
    }
    if (await alreadyAlertedStory(store, observation.title, policy.storyWindowHours)) {
      await store.markHeld(judgment.id, "same_story");
      continue;
    }
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
    const { webhookUrl, ntfy, barkUrl, slackWebhookUrl } = deps;
    if (webhookUrl) channels.push(() => deliverWebhook(webhookUrl, payload, deps.fetch));
    if (ntfy) channels.push(() => deliverNtfy(ntfy, payload, deps.fetch));
    const barkWorthy =
      alert.reason === "direct" &&
      (deps.barkRequiresMaterial ? judgment.material === true : alert.score >= (deps.barkMinScore ?? 0));
    if (barkUrl && barkWorthy) {
      channels.push(() => deliverBark(barkUrl, payload, deps.fetch));
    }
    if (slackWebhookUrl) channels.push(() => deliverSlack(slackWebhookUrl, payload, deps.fetch));
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
    const baseline = !(await deps.store.hasObservations(source.id));
    const result = await processItems(deps, source, items, { baseline });
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

async function coolingDown(store: Store, decision: AlertDecision, policy: PipelineDeps["policy"]): Promise<boolean> {
  const { alertCooldownHours, cooldownBypassScore } = policy;
  if (!alertCooldownHours || !decision.targetKey || decision.material) return false;
  if (decision.reason === "direct" && cooldownBypassScore !== undefined && decision.score >= cooldownBypassScore) return false;
  const last = await store.lastAlertAt(decision.targetKey);
  return last !== null && Date.parse(last) > Date.now() - alertCooldownHours * 3600_000;
}

async function alreadyAlertedStory(store: Store, title: string, windowHours: number | undefined): Promise<boolean> {
  if (!windowHours) return false;
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  return (await store.recentAlertTitles(since)).some((t) => sameStory(t, title));
}

function isStale(publishedAt: string | null, maxAgeHours: number | undefined): boolean {
  if (!publishedAt || !maxAgeHours) return false;
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) && t < Date.now() - maxAgeHours * 3600_000;
}
