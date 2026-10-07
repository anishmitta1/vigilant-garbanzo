import {
  buildPayload,
  decideAlert,
  decideEventAlert,
  deliverBark,
  deliverNtfy,
  deliverSlack,
  deliverWebhook,
  type AlertDecision,
  type AlertPolicy,
} from "./alerts.js";
import type { NtfyConfig } from "./config.js";
import type { PillarEvidence, Store } from "./db.js";
import { embedText, findCandidates, placeInEvent, type EventCandidate, type EventIndex, type Placement } from "./events.js";
import { normalize, sameStory } from "./preprocess.js";
import { heuristicScorer } from "./scoring/heuristic.js";
import type { Scorer } from "./scoring/types.js";
import { getAdapter } from "./sources/registry.js";
import type { SourceContext } from "./sources/types.js";
import { isMajor, type Alert, type HeldReason, type RawItem, type Source } from "./types.js";
import { errorMessage, newId } from "./util.js";

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
    /** "events": alert on new major pillar impacts instead of material verdicts. */
    alertMode?: "legacy" | "events";
  };
  /** Event grouping; without it, items are judged one by one as before. */
  events?: EventIndex;
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
  /** Clock override, so a replay judges history as of when each item was seen. */
  now?: () => Date;
}

const TITLE_DEDUPE_WINDOW_MS = 7 * 24 * 3600_000;
const EVIDENCE_WINDOW_MS = 14 * 24 * 3600_000;
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
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const at = new Date(nowMs).toISOString();
  const since = new Date(nowMs - policy.accumulationWindowHours * 3600_000).toISOString();
  const titleSince =
    getAdapter(source.type).dedupeByTitle === false ? null : new Date(nowMs - TITLE_DEDUPE_WINDOW_MS).toISOString();
  const { events } = deps;
  const evidence: PillarEvidence[] = events ? await store.impactsSince(new Date(nowMs - EVIDENCE_WINDOW_MS).toISOString()) : [];
  const pillarNames = new Map(watchlist.trades.flatMap((t) => t.pillars.map((p) => [p.id, p.statement] as const)));

  for (const item of items) {
    const draft = normalize(source.id, item);
    if (!draft) continue;
    if (await store.isDuplicate(draft, titleSince)) {
      result.duplicates++;
      continue;
    }
    const observation = await store.insertObservation(draft, at);
    result.inserted++;

    let vector: Float32Array | null = null;
    let candidates: EventCandidate[] = [];
    if (events) {
      try {
        vector = await events.embedder.embed(embedText(observation, source));
      } catch (err) {
        deps.log?.(`event embedding failed: ${errorMessage(err)}`);
      }
      // The pushed-event memory works even if the local model cannot load.
      candidates = await findCandidates(store, events, vector, nowMs);
    }
    const place = async (j: Parameters<typeof placeInEvent>[2]["judgment"]): Promise<Placement | null> => {
      if (!events) return null;
      const placed = await placeInEvent(store, events, { observationId: observation.id, title: observation.title, judgment: j, vector, candidates }, at, nowMs);
      const title = (candidates.find((c) => c.id === placed.eventId)?.title ?? j.event?.title) || observation.title;
      evidence.unshift(...placed.added.map((i) => ({ eventId: i.eventId, tradeId: i.tradeId, pillarId: i.pillarId, effect: i.effect, eventTitle: title, rationale: i.rationale, createdAt: at })));
      return placed;
    };

    // Backlog (e.g. a feed's history on first poll) and a new source's first batch are stored and scored
    // but never alert or accumulate, so they get the free heuristic rather than a model call.
    const held: HeldReason | undefined = isStale(observation.publishedAt, policy.maxAlertAgeHours, nowMs) ? "stale" : opts.baseline ? "baseline" : undefined;
    const scored = held
      ? await heuristicScorer.judge(observation, source, watchlist)
      : await scorer.judge(observation, source, watchlist, events ? { candidates, evidence } : undefined);
    const judgment = { ...scored, ...(held ? { held } : {}), id: newId(), observationId: observation.id, createdAt: at };
    if (held) {
      await store.insertJudgment(judgment, held === "stale" ? new Date(observation.publishedAt!).toISOString() : BASELINE_SIGNAL_AT);
      await place(judgment);
      continue;
    }
    const placed = await place(judgment);
    if (placed?.joined) {
      judgment.material = false;
      judgment.impacts = [];
      judgment.held = "same_event";
      await store.insertJudgment(judgment, BASELINE_SIGNAL_AT);
      continue;
    }
    const priorWeakSums = new Map<string, number>();
    for (const m of judgment.matches) {
      priorWeakSums.set(m.targetKey, await store.weakSignalSum(m.targetKey, since, policy.weakSignalFloor, policy.alertThreshold));
    }
    await store.insertJudgment(judgment);

    const decision =
      policy.alertMode === "events" ? decideEventAlert(judgment, placed?.added ?? []) : decideAlert(judgment, priorWeakSums, policy);
    if (!decision) continue;
    if (await coolingDown(store, decision, policy, nowMs)) {
      await store.markHeld(judgment.id, "cooldown");
      continue;
    }
    if (await alreadyAlertedStory(store, observation.title, policy.storyWindowHours, nowMs)) {
      await store.markHeld(judgment.id, "same_story");
      continue;
    }
    const alert = await store.insertAlert({
      observationId: observation.id,
      judgmentId: judgment.id,
      reason: decision.reason,
      score: decision.score,
      targetKey: decision.targetKey,
      eventId: placed?.eventId ?? null,
      delivered: false,
      deliveryError: null,
    }, at);
    deps.log?.(`ALERT [${decision.reason} ${decision.score}] ${observation.title}`);
    const moved = (placed?.added ?? []).filter((i) => isMajor(i.effect) && i.pillarId).map((i) => pillarNames.get(i.pillarId!)!);
    const payload = buildPayload(alert, observation, judgment, source, moved.filter(Boolean));
    const channels: (() => Promise<void>)[] = [];
    const { webhookUrl, ntfy, barkUrl, slackWebhookUrl } = deps;
    if (webhookUrl) channels.push(() => deliverWebhook(webhookUrl, payload, deps.fetch));
    if (ntfy) channels.push(() => deliverNtfy(ntfy, payload, deps.fetch));
    const barkWorthy =
      alert.reason === "direct" &&
      (policy.alertMode === "events" ||
        (deps.barkRequiresMaterial ? judgment.material === true : alert.score >= (deps.barkMinScore ?? 0)));
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

async function coolingDown(store: Store, decision: AlertDecision, policy: PipelineDeps["policy"], nowMs: number): Promise<boolean> {
  const { alertCooldownHours, cooldownBypassScore } = policy;
  if (!alertCooldownHours || !decision.targetKey || decision.material) return false;
  if (decision.reason === "direct" && cooldownBypassScore !== undefined && decision.score >= cooldownBypassScore) return false;
  const last = await store.lastAlertAt(decision.targetKey);
  return last !== null && Date.parse(last) > nowMs - alertCooldownHours * 3600_000;
}

async function alreadyAlertedStory(store: Store, title: string, windowHours: number | undefined, nowMs: number): Promise<boolean> {
  if (!windowHours) return false;
  const since = new Date(nowMs - windowHours * 3600_000).toISOString();
  return (await store.recentAlertTitles(since)).some((t) => sameStory(t, title));
}

function isStale(publishedAt: string | null, maxAgeHours: number | undefined, nowMs: number): boolean {
  if (!publishedAt || !maxAgeHours) return false;
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) && t < nowMs - maxAgeHours * 3600_000;
}
