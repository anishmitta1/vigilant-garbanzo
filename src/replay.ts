// Replays stored history through the real pipeline, with each item judged as of when it was fetched.
// Delivery is impossible: no channel is configured and any network call throws.
import type { Client, Row } from "@libsql/client";
import type { DigestRow, Store } from "./db.js";
import { isNearMiss, latencyMinutes, pushesSince } from "./digest.js";
import type { Push } from "./market.js";
import { processItems, type PipelineDeps } from "./pipeline.js";
import { heuristicScorer } from "./scoring/heuristic.js";
import type { JudgmentDraft, Scorer } from "./scoring/types.js";
import type { HeldReason, Observation, TargetMatch } from "./types.js";

export interface HistoryRow {
  sourceId: string;
  externalId: string;
  title: string;
  url: string | null;
  summary: string;
  publishedAt: string | null;
  fetchedAt: string;
  /** Production's saved model verdict (null if the item got the heuristic or the call failed). */
  verdict: JudgmentDraft | null;
  /** A polled source's first batch stays silent in production; replay keeps it silent. */
  baseline: boolean;
}

export interface ReplayResult {
  from: string;
  to: string;
  days: number;
  items: number;
  skipped: number;
  alerts: number;
  pushes: (Push & { consequence: number; rationale: string; matches: TargetMatch[]; lateMinutes: number | null })[];
  held: Partial<Record<HeldReason, number>>;
  verdicts: { material: number; notMaterial: number; noModel: number };
  nearMisses: DigestRow[];
  /** Every judgment, highest consequence first. */
  judged: DigestRow[];
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const key = (sourceId: string, externalId: string): string => `${sourceId}\u0000${externalId}`;
const isModelVerdict = (j: { scorer: string; rationale: string }): boolean =>
  j.scorer.startsWith("llm:") && !j.rationale.includes("(LLM fallback");

function toVerdict(r: Row): JudgmentDraft | null {
  if (!r.scorer || !isModelVerdict({ scorer: str(r.scorer), rationale: str(r.rationale) })) return null;
  return {
    scorer: str(r.scorer),
    eventType: str(r.event_type),
    consequence: Number(r.consequence),
    urgency: Number(r.urgency),
    matches: JSON.parse(str(r.matches) || "[]") as TargetMatch[],
    rationale: str(r.rationale),
    ...(r.material === null || r.material === undefined ? {} : { material: Number(r.material) === 1 }),
  };
}

/** A source's first poll is stored within this long of its first item. */
const FIRST_POLL_MS = 120_000;

/**
 * Every stored observation in fetch order, with production's saved verdict. First-poll items are marked from
 * timing, since older rows predate the `baseline` tag.
 */
export async function loadHistory(client: Client): Promise<HistoryRow[]> {
  const res = await client.execute(
    `SELECT o.source_id, o.external_id, o.title, o.url, o.summary, o.published_at, o.fetched_at, s.type AS source_type,
            j.scorer, j.event_type, j.consequence, j.urgency, j.matches, j.rationale, j.material, j.held
     FROM observations o
     JOIN sources s ON s.id = o.source_id
     LEFT JOIN judgments j ON j.observation_id = o.id
     ORDER BY o.fetched_at, o.rowid`,
  );
  const firstFetch = new Map<string, number>();
  for (const r of res.rows) if (!firstFetch.has(str(r.source_id))) firstFetch.set(str(r.source_id), Date.parse(str(r.fetched_at)));
  const firstPoll = (r: Row): boolean =>
    r.source_type !== "push" && Date.parse(str(r.fetched_at)) - firstFetch.get(str(r.source_id))! < FIRST_POLL_MS;
  return res.rows.map((r) => ({
    sourceId: str(r.source_id),
    externalId: str(r.external_id),
    title: str(r.title),
    url: r.url ? str(r.url) : null,
    summary: str(r.summary),
    publishedAt: r.published_at ? str(r.published_at) : null,
    fetchedAt: str(r.fetched_at),
    verdict: toVerdict(r),
    baseline: r.held === "baseline" || firstPoll(r),
  }));
}

/** Items worth re-asking the model about when testing a prompt: it called them material or near the bar. */
export const isCandidate = (v: JudgmentDraft | null): boolean => v !== null && (v.material === true || v.consequence >= 0.3);

/**
 * Reuses saved verdicts (free, deterministic). With `model`, re-asks it for candidates (or every item with `all`),
 * caching fresh verdicts by title so re-runs are free.
 */
export function historyScorer(
  rows: HistoryRow[],
  opts: { model?: Scorer; all?: boolean; cache?: Map<string, JudgmentDraft> } = {},
): Scorer & { modelCalls: () => number } {
  const saved = new Map(rows.map((r) => [key(r.sourceId, r.externalId), r.verdict]));
  const cache = opts.cache ?? new Map<string, JudgmentDraft>();
  let calls = 0;
  return {
    name: opts.model ? `replay:${opts.model.name}` : "replay:saved",
    modelCalls: () => calls,
    async judge(observation: Observation, source, watchlist) {
      const verdict = saved.get(key(observation.sourceId, observation.externalId)) ?? null;
      const { model } = opts;
      if (model && (opts.all || isCandidate(verdict))) {
        const cached = cache.get(observation.title);
        if (cached) return cached;
        calls++;
        const fresh = await model.judge(observation, source, watchlist);
        if (isModelVerdict(fresh)) cache.set(observation.title, fresh);
        return fresh;
      }
      return verdict ?? heuristicScorer.judge(observation, source, watchlist);
    },
  };
}

const refuse = (async () => {
  throw new Error("replay never makes network calls");
}) as typeof fetch;

/** Wipes `store`'s events (it must be a scratch copy), then replays `rows` in order with the clock at each fetch time. */
export async function replayHistory(store: Store, rows: HistoryRow[], opts: { scorer: Scorer; policy: PipelineDeps["policy"] }): Promise<ReplayResult> {
  await store.resetEvents();
  const sources = new Map((await store.listSources()).map((s) => [s.id, s]));
  const deps: PipelineDeps = { store, scorer: opts.scorer, policy: opts.policy, sourceContext: { fetch: refuse, userAgent: "mimir-replay" }, fetch: refuse };
  let skipped = 0;
  for (const row of rows) {
    const source = sources.get(row.sourceId);
    if (!source) {
      skipped++;
      continue;
    }
    const item = {
      externalId: row.externalId,
      title: row.title,
      url: row.url ?? undefined,
      summary: row.summary || undefined,
      publishedAt: row.publishedAt ?? undefined,
    };
    await processItems({ ...deps, now: () => new Date(row.fetchedAt) }, source, [item], { baseline: row.baseline });
  }

  const epoch = new Date(0).toISOString();
  const judged = await store.digestRows(epoch);
  const alerts = await store.alertsSince(epoch);
  const byTitle = new Map(alerts.map((a) => [a.title, a.judgment]));
  const published = new Map(judged.map((r) => [r.title, r.publishedAt]));
  const pushes = (await pushesSince(store, epoch)).map((p) => {
    const j = byTitle.get(p.title)!;
    return { ...p, consequence: j.consequence, rationale: j.rationale, matches: j.matches, lateMinutes: latencyMinutes(published.get(p.title) ?? null, p.at) };
  });
  const held: Partial<Record<HeldReason, number>> = {};
  for (const r of judged) if (r.judgment.held) held[r.judgment.held] = (held[r.judgment.held] ?? 0) + 1;
  const scored = judged.filter((r) => !r.judgment.held || r.judgment.held === "cooldown" || r.judgment.held === "same_story");
  const from = rows[0]?.fetchedAt ?? epoch;
  const to = rows.at(-1)?.fetchedAt ?? epoch;
  return {
    from,
    to,
    days: Math.max(1, Math.round(((Date.parse(to) - Date.parse(from)) / 86_400_000) * 10) / 10),
    items: rows.length,
    skipped,
    alerts: alerts.length,
    pushes,
    held,
    verdicts: {
      material: scored.filter((r) => r.judgment.material === true).length,
      notMaterial: scored.filter((r) => r.judgment.material === false).length,
      noModel: scored.filter((r) => r.judgment.material === undefined).length,
    },
    nearMisses: judged.filter(isNearMiss).slice(0, 10),
    judged,
  };
}
