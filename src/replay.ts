// Replays stored history through the real pipeline, with each item judged as of when it was fetched.
// Delivery is impossible: no channel is configured and any network call throws.
import type { Client, Row } from "@libsql/client";
import { createHash } from "node:crypto";
import type { DigestRow, Store } from "./db.js";
import { isNearMiss, latencyMinutes, pushesSince } from "./digest.js";
import type { Push } from "./market.js";
import type { EventCandidate, EventIndex } from "./events.js";
import { processItems, type PipelineDeps } from "./pipeline.js";
import { heuristicScorer } from "./scoring/heuristic.js";
import type { JudgeContext, JudgmentDraft, Scorer } from "./scoring/types.js";
import type { HeldReason, Observation, TargetMatch, Watchlist } from "./types.js";

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

export type CachedVerdict = JudgmentDraft & { sameAsTitle?: string; sameAsEvent?: string; pillarRefs?: Record<string, string> };

const eventKey = (e: EventCandidate): string => JSON.stringify([e.title, e.type, e.entities, e.firstSeenAt]);
const pillarRefs = (w: Watchlist): Map<string, string> => new Map(w.trades.flatMap((t) => t.pillars.map((p, n) => [p.id, `${t.id}/${n}`] as const)));

/** Grouped judgments depend on the memory shown to the scorer, not just a headline. Exclude scratch ids. */
function groupedCacheKey(o: Observation, source: { id: string; type: string; name: string; weight: number }, w: Watchlist, c: JudgeContext, model: Scorer): string {
  const pillars = pillarRefs(w);
  const events = new Map<string, number>();
  const eventRef = (id: string) => {
    if (!events.has(id)) events.set(id, events.size);
    return events.get(id);
  };
  const input = {
    model: model.name, version: model.cacheVersion,
    observation: [o.sourceId, o.externalId, o.title, o.summary, o.publishedAt, o.fetchedAt],
    source: [source.id, source.type, source.name, source.weight],
    watchlist: {
      themes: w.themes.map(({ id, name, description, keywords }) => ({ id, name, description, keywords })),
      entities: w.entities.map(({ id, name, kind, aliases }) => ({ id, name, kind, aliases })),
      trades: w.trades.map((t) => ({
        id: t.id, name: t.name, thesis: t.thesis, keywords: t.keywords, tickers: t.tickers, entities: t.entities,
        strengthens: t.strengthens, weakens: t.weakens,
        pillars: t.pillars.map((p) => ({ id: pillars.get(p.id), statement: p.statement, active: p.active, signals: p.signals })),
      })),
    },
    candidates: c.candidates?.map((e) => ({
      event: eventRef(e.id), key: eventKey(e), reports: e.items, alerted: e.alerted,
      impacts: e.impacts?.map((i) => ({ tradeId: i.tradeId, pillar: i.pillarId === null ? null : pillars.get(i.pillarId), effect: i.effect, rationale: i.rationale })),
    })),
    evidence: c.evidence?.map(({ eventId, pillarId, ...e }) => ({ ...e, event: eventRef(eventId), pillar: pillarId === null ? null : pillars.get(pillarId) })),
  };
  return `events-v2:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

/** Items worth re-asking the model about when testing a prompt: it called them material or near the bar. */
export const isCandidate = (v: JudgmentDraft | null): boolean => v !== null && (v.material === true || v.consequence >= 0.3);

/**
 * Reuses saved verdicts (free, deterministic). With `model`, re-asks it for candidates (or every item with `all`),
 * caching fresh verdicts by title so re-runs are free.
 */
export function historyScorer(
  rows: HistoryRow[],
  opts: { model?: Scorer; all?: boolean; cache?: Map<string, CachedVerdict> } = {},
): Scorer & { modelCalls: () => number } {
  const saved = new Map(rows.map((r) => [key(r.sourceId, r.externalId), r.verdict]));
  const cache = opts.cache ?? new Map<string, CachedVerdict>();
  let calls = 0;
  return {
    name: opts.model ? `replay:${opts.model.name}` : "replay:saved",
    modelCalls: () => calls,
    async judge(observation: Observation, source, watchlist, context) {
      const verdict = saved.get(key(observation.sourceId, observation.externalId)) ?? null;
      const { model } = opts;
      if (model && (opts.all || isCandidate(verdict))) {
        const candidates = context?.candidates ?? [];
        const cacheKey = context ? groupedCacheKey(observation, source, watchlist, context, model) : observation.title;
        const cached = cache.get(cacheKey);
        // Scratch event and preset pillar ids differ between CLI runs; remap their stable references.
        if (cached) {
          const { sameAsTitle, sameAsEvent, pillarRefs: refs, ...draft } = cached;
          const current = new Map([...pillarRefs(watchlist)].map(([id, ref]) => [ref, id]));
          return {
            ...draft,
            ...(draft.event ? { event: { ...draft.event, sameAs: candidates.find((c) => sameAsEvent ? eventKey(c) === sameAsEvent : c.title === sameAsTitle)?.id ?? null } } : {}),
            ...(draft.impacts ? { impacts: draft.impacts.map((i) => ({ ...i, pillarId: i.pillarId === null ? null : current.get(refs?.[i.pillarId] ?? "") ?? i.pillarId })) } : {}),
          };
        }
        calls++;
        const fresh = await model.judge(observation, source, watchlist, context);
        const sameAsTitle = candidates.find((c) => c.id === fresh.event?.sameAs)?.title;
        const sameAs = candidates.find((c) => c.id === fresh.event?.sameAs);
        if (isModelVerdict(fresh)) cache.set(cacheKey, {
          ...fresh,
          ...(context ? { pillarRefs: Object.fromEntries(pillarRefs(watchlist)), ...(sameAs ? { sameAsEvent: eventKey(sameAs) } : {}) } : sameAsTitle ? { sameAsTitle } : {}),
        });
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
export async function replayHistory(
  store: Store,
  rows: HistoryRow[],
  opts: { scorer: Scorer; policy: PipelineDeps["policy"]; events?: EventIndex },
): Promise<ReplayResult> {
  await store.resetEvents();
  opts.events?.reset();
  const sources = new Map((await store.listSources()).map((s) => [s.id, s]));
  const deps: PipelineDeps = {
    store,
    scorer: opts.scorer,
    policy: opts.policy,
    events: opts.events,
    sourceContext: { fetch: refuse, userAgent: "mimir-replay" },
    fetch: refuse,
  };
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
  const scored = judged.filter((r) => !r.judgment.held || ["cooldown", "same_story", "same_event"].includes(r.judgment.held));
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
