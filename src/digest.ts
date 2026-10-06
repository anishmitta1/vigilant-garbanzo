import { describeTargets } from "./alerts.js";
import type { DigestRow, Store } from "./db.js";

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

/** Model calls skipped because the daily cap was hit or the call failed (heuristic fallback). */
const modelSkipped = (row: DigestRow): string | null =>
  row.judgment.rationale.includes("(LLM daily cap reached)")
    ? "no model: daily cap"
    : row.judgment.rationale.includes("(LLM fallback")
      ? "no model: error"
      : null;

function nearMissReason(row: DigestRow): string {
  const { material, held } = row.judgment;
  if (held === "same_story") return "same story already alerted";
  if (held === "cooldown") return "cooldown";
  const skipped = modelSkipped(row);
  if (skipped) return skipped;
  if (material === true) return "material, below bar";
  if (material === false) return "not material";
  return "keyword score";
}

/** Today's alerts, the strongest items that didn't alert, and pipeline health, sized for one Bark push. */
export function buildDigest(rows: DigestRow[], opts: { dateLabel: string; failingSources: string[] }): Digest {
  const alerted = rows.filter((r) => r.alerted);
  // Backlog and first-poll items could never alert, so they aren't misses.
  const eligible = rows.filter((r) => r.judgment.held !== "stale" && r.judgment.held !== "baseline");
  const nearMisses = eligible.filter(
    (r) => !r.alerted && r.judgment.matches.length > 0 && (r.judgment.material === true || r.judgment.consequence >= NEAR_MISS_FLOOR),
  );
  const modelCalls = rows.filter((r) => r.judgment.scorer.startsWith("llm:")).length;
  const skipped = eligible.filter((r) => modelSkipped(r) !== null).length;

  const lines: string[] = [];
  lines.push(alerted.length > 0 ? `ALERTS (${alerted.length})` : "No alerts.");
  for (const r of alerted.slice(0, MAX_LINES)) {
    lines.push(`• ${clip(r.title, 110)} — ${describeTargets(r.judgment.matches)}`);
  }
  if (alerted.length > MAX_LINES) lines.push(`  +${alerted.length - MAX_LINES} more`);
  if (nearMisses.length > 0) {
    lines.push("", `NEAR-MISSES (${nearMisses.length}, not sent)`);
    for (const r of nearMisses.slice(0, MAX_LINES)) {
      lines.push(`• ${r.judgment.consequence.toFixed(2)} ${clip(r.title, 100)} [${nearMissReason(r)}]`);
      if (r.judgment.rationale) lines.push(`  ${clip(r.judgment.rationale, 140)}`);
    }
  }
  lines.push("", `Read ${rows.length} items · ${modelCalls} model calls`);
  if (skipped > 0) lines.push(`⚠ ${skipped} items missed the model (daily cap or errors) and could not alert`);
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
export async function composeDigest(store: Store, now: Date, timeZone: string, since?: string): Promise<Digest> {
  const from = since ?? (await store.getMeta(LAST_SENT_KEY)) ?? new Date(now.getTime() - 24 * 3600_000).toISOString();
  const failingSources = (await store.listSources()).filter((s) => s.enabled && s.lastError).map((s) => s.name);
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(now);
  return buildDigest(await store.digestRows(from), { dateLabel, failingSources });
}

/** Send the daily digest to Bark if it's due. Returns whether one was sent. */
export async function maybeSendDigest(
  deps: { store: Store; barkUrl: string; fetch?: typeof fetch; log?: (msg: string) => void },
  schedule: DigestSchedule,
  now = new Date(),
): Promise<boolean> {
  if (!digestDue(now, schedule, await deps.store.getMeta(LAST_SENT_KEY))) return false;
  const digest = await composeDigest(deps.store, now, schedule.timeZone);
  await deliverDigestBark(deps.barkUrl, digest, deps.fetch);
  await deps.store.setMeta(LAST_SENT_KEY, now.toISOString());
  deps.log?.(`digest sent: ${digest.subtitle}`);
  return true;
}
