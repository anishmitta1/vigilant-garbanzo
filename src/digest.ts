import { describeTargets } from "./alerts.js";
import type { DigestRow, Store } from "./db.js";
import { checkMarket, etParts, inSession, loadPrices, summarizeMarket, type MarketSummary, type Push, type TradeDay } from "./market.js";
import { errorMessage } from "./util.js";

const LAST_SENT_KEY = "digest:last_sent_at";
/** Unalerted items at or above this consequence are listed as near-misses. */
const NEAR_MISS_FLOOR = 0.3;
const MAX_LINES = 6;
/** Bark relays to APNs, which caps a push at 4 KB. */
const MAX_BODY_CHARS = 2500;

export interface DigestSchedule {
  /** Local "HH:MM". */
  time: string;
  timeZone: string;
}

export interface Digest {
  title: string;
  subtitle: string;
  body: string;
}

/** Local calendar date ("YYYY-MM-DD") and time ("HH:MM") of `at` in `timeZone`. */
export function localParts(at: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Due once per local day, at or after the scheduled time. */
export function digestDue(now: Date, schedule: DigestSchedule, lastSentAt: string | null): boolean {
  const today = localParts(now, schedule.timeZone);
  if (today.time < schedule.time) return false;
  return lastSentAt === null || localParts(new Date(lastSentAt), schedule.timeZone).date !== today.date;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Model calls that failed, e.g. provider error or spend limit (heuristic fallback). */
const modelSkipped = (row: DigestRow): string | null => (row.judgment.rationale.includes("(LLM fallback") ? "no model: error" : null);

export function nearMissReason(row: DigestRow): string {
  const { material, held } = row.judgment;
  if (held === "same_story") return "same story already alerted";
  if (held === "cooldown") return "cooldown";
  const skipped = modelSkipped(row);
  if (skipped) return skipped;
  if (material === true) return "material, below bar";
  if (material === false) return "not material";
  return "keyword score";
}

/** Minutes from the source's publish time to the push (null if unknown or the source's clock is ahead). */
export function latencyMinutes(publishedAt: string | null, at: string): number | null {
  if (!publishedAt) return null;
  const ms = Date.parse(at) - Date.parse(publishedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60_000) : null;
}

/** Median publish-to-push minutes over alerted rows. */
export function medianLatency(rows: DigestRow[]): { minutes: number; n: number } | null {
  const xs = rows
    .filter((r) => r.alerted)
    .map((r) => latencyMinutes(r.publishedAt, r.judgment.createdAt))
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return { minutes: xs.length % 2 ? xs[mid]! : Math.round((xs[mid - 1]! + xs[mid]!) / 2), n: xs.length };
}

// Backlog, first-poll and triaged-out items never got a full judgment, so they aren't misses.
const eligible = (r: DigestRow): boolean => !["stale", "baseline", "triaged"].includes(r.judgment.held ?? "");

export const isNearMiss = (r: DigestRow): boolean =>
  eligible(r) && !r.alerted && r.judgment.matches.length > 0 && (r.judgment.material === true || r.judgment.consequence >= NEAR_MISS_FLOOR);

/** Strongest unalerted item on the day's trade, judged during that session (rows sorted by consequence, highest first). */
export function closestOnTrade(rows: DigestRow[], day: TradeDay): DigestRow | undefined {
  const key = `trade:${day.tradeId}`;
  return rows.find(
    (r) => eligible(r) && !r.alerted && r.judgment.matches.some((m) => m.targetKey === key) && inSession(r.judgment.createdAt, day.prevDate, day.date),
  );
}

/** Pushes: alerts the model called material (the only ones that reach Bark with a model configured). */
export async function pushesSince(store: Store, since: string): Promise<Push[]> {
  return (await store.alertsSince(since))
    .filter((a) => a.judgment.material === true)
    .map((a) => ({
      at: a.createdAt,
      title: a.title,
      tradeIds: a.judgment.matches.filter((m) => m.targetKey.startsWith("trade:")).map((m) => m.targetKey.slice("trade:".length)),
    }));
}

export type DigestMarket =
  | { today: { day: TradeDay; closest?: DigestRow }[]; session: boolean; last30: MarketSummary; missing: string[] }
  | { error: string };

const MARKET_DAYS = 30;

/** Today's unusual basket moves (caught or missed) and a 30-day scorecard, from free daily prices. */
export async function digestMarket(store: Store, rows: DigestRow[], now: Date, fetchImpl: typeof fetch = fetch): Promise<DigestMarket> {
  try {
    // Sessions before Mimir started aren't misses.
    const first = await store.firstObservationAt();
    const from = new Date(Math.max(now.getTime() - MARKET_DAYS * 86_400_000, first ? Date.parse(first) : now.getTime()));
    const trades = await store.listTrades();
    const prices = await loadPrices(trades, from, now, fetchImpl);
    const check = checkMarket(trades, prices, await pushesSince(store, from.toISOString()), from, now);
    const today = etParts(now).date;
    const todays = check.days.filter((d) => d.date === today);
    return {
      today: todays.filter((d) => d.big).map((day) => ({ day, closest: day.caught.length > 0 ? undefined : closestOnTrade(rows, day) })),
      session: todays.length > 0,
      last30: summarizeMarket(check),
      missing: check.missing,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function marketLines(m: DigestMarket): string[] {
  if ("error" in m) return ["", `Market check unavailable: ${clip(m.error, 100)}`];
  const lines = ["", "MARKET (basket move vs a normal day)"];
  if (!m.session) lines.push("• No market session to score today");
  else if (m.today.length === 0) lines.push("• No unusual moves");
  for (const { day, closest } of m.today) {
    const ratio = `${(day.ratio ?? 0).toFixed(1)}×`;
    if (day.caught.length > 0) lines.push(`• ${day.tradeName} ${ratio} — pushed ✓`);
    else if (closest) lines.push(`• ${day.tradeName} ${ratio} — missed · closest ${closest.judgment.consequence.toFixed(2)} ${clip(closest.title, 80)} [${nearMissReason(closest)}]`);
    else lines.push(`• ${day.tradeName} ${ratio} — missed · nothing matched`);
  }
  const s = m.last30;
  lines.push(`${MARKET_DAYS}d: caught ${s.caught}/${s.bigDays} big days · ${s.quietPushes} of ${s.labelledPushes} pushes on quiet days`);
  if (m.missing.length > 0) lines.push(`No prices: ${m.missing.join(", ")}`);
  return lines;
}

/** Today's alerts, the strongest items that didn't alert, and pipeline health, sized for one Bark push. */
/** Per trade, events the model found relevant but that fit none of its pillars: a cue to add one. */
export interface PillarGap {
  trade: string;
  events: string[];
}

export async function pillarGaps(store: Store, since: string): Promise<PillarGap[]> {
  const names = new Map((await store.listTrades()).map((t) => [t.id, t.name]));
  const byTrade = new Map<string, Set<string>>();
  for (const i of await store.impactsSince(since)) {
    if (i.pillarId !== null || !names.has(i.tradeId)) continue;
    const set = byTrade.get(i.tradeId) ?? new Set<string>();
    set.add(i.eventTitle);
    byTrade.set(i.tradeId, set);
  }
  return [...byTrade].map(([id, events]) => ({ trade: names.get(id)!, events: [...events] })).sort((a, b) => b.events.length - a.events.length);
}

export function buildDigest(
  rows: DigestRow[],
  opts: { dateLabel: string; failingSources: string[]; market?: DigestMarket; gaps?: PillarGap[] },
): Digest {
  const alerted = rows.filter((r) => r.alerted);
  const nearMisses = rows.filter(isNearMiss);
  const modelCalls = rows.filter((r) => r.judgment.scorer.startsWith("llm:")).length;
  const skipped = rows.filter((r) => eligible(r) && modelSkipped(r) !== null).length;

  const lines: string[] = [];
  lines.push(alerted.length > 0 ? `ALERTS (${alerted.length})` : "No alerts.");
  for (const r of alerted.slice(0, MAX_LINES)) {
    lines.push(`• ${clip(r.title, 110)} — ${describeTargets(r.judgment.matches)}`);
  }
  if (alerted.length > MAX_LINES) lines.push(`  +${alerted.length - MAX_LINES} more`);
  const lag = medianLatency(rows);
  if (lag) lines.push(`Latency published → alert: median ${lag.minutes}m`);
  if (opts.market) lines.push(...marketLines(opts.market));
  if (nearMisses.length > 0) {
    lines.push("", `NEAR-MISSES (${nearMisses.length}, not sent)`);
    for (const r of nearMisses.slice(0, MAX_LINES)) {
      lines.push(`• ${r.judgment.consequence.toFixed(2)} ${clip(r.title, 100)} [${nearMissReason(r)}]`);
      if (r.judgment.rationale) lines.push(`  ${clip(r.judgment.rationale, 140)}`);
    }
  }
  if (opts.gaps && opts.gaps.length > 0) {
    lines.push("", "FITS NO PILLAR (relevant, but no axiom covers it)");
    for (const g of opts.gaps.slice(0, MAX_LINES)) {
      lines.push(`• ${g.trade}: ${g.events.length} event${g.events.length === 1 ? "" : "s"}, e.g. ${clip(g.events[0]!, 90)}`);
    }
  }
  lines.push("", `Read ${rows.length} items · ${modelCalls} model calls`);
  if (skipped > 0) lines.push(`⚠ ${skipped} items missed the model (call errors or spend limit) and could not alert`);
  if (opts.failingSources.length > 0) lines.push(`Failing sources: ${opts.failingSources.join(", ")}`);

  return {
    title: `Mimir daily digest · ${opts.dateLabel}`,
    subtitle: `${alerted.length} alert${alerted.length === 1 ? "" : "s"} · ${nearMisses.length} near-miss${nearMisses.length === 1 ? "" : "es"}`,
    body: clip(lines.join("\n"), MAX_BODY_CHARS),
  };
}

export async function deliverDigestBark(barkUrl: string, digest: Digest, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(barkUrl.replace(/\/+$/, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...digest, level: "active", group: "Mimir digest" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bark HTTP ${res.status}`);
}

/** Digest covering everything since `since` (default: the last digest, or 24h). */
export async function composeDigest(
  store: Store,
  now: Date,
  timeZone: string,
  since?: string,
  opts: { market?: boolean; fetch?: typeof fetch } = {},
): Promise<Digest> {
  const from = since ?? (await store.getMeta(LAST_SENT_KEY)) ?? new Date(now.getTime() - 24 * 3600_000).toISOString();
  const failingSources = (await store.listSources()).filter((s) => s.enabled && s.lastError).map((s) => s.name);
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(now);
  const rows = await store.digestRows(from);
  const market = opts.market ? await digestMarket(store, rows, now, opts.fetch) : undefined;
  return buildDigest(rows, { dateLabel, failingSources, market, gaps: await pillarGaps(store, from) });
}

/** Send the daily digest to Bark if it's due. Returns whether one was sent. */
export async function maybeSendDigest(
  deps: { store: Store; barkUrl: string; market?: boolean; fetch?: typeof fetch; log?: (msg: string) => void },
  schedule: DigestSchedule,
  now = new Date(),
): Promise<boolean> {
  if (!digestDue(now, schedule, await deps.store.getMeta(LAST_SENT_KEY))) return false;
  const digest = await composeDigest(deps.store, now, schedule.timeZone, undefined, { market: deps.market, fetch: deps.fetch });
  await deliverDigestBark(deps.barkUrl, digest, deps.fetch);
  await deps.store.setMeta(LAST_SENT_KEY, now.toISOString());
  deps.log?.(`digest sent: ${digest.subtitle}`);
  return true;
}
