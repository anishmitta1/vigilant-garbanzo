import type { NtfyConfig } from "./config.js";
import type { Judgment, Observation, Source } from "./types.js";
import type { Alert, AlertReason } from "./types.js";

export interface AlertPolicy {
  alertThreshold: number;
  weakSignalFloor: number;
  accumulationThreshold: number;
}

export interface AlertDecision {
  reason: AlertReason;
  score: number;
  targetKey: string | null;
}

/**
 * Decide whether a judgment should alert. Strong signals alert directly; weak
 * signals accumulate per target so a run of small developments still surfaces.
 * `priorWeakSums` maps target key -> weak-signal total before this judgment.
 */
export function decideAlert(
  judgment: Pick<Judgment, "consequence" | "matches">,
  priorWeakSums: Map<string, number>,
  policy: AlertPolicy,
): AlertDecision | null {
  if (judgment.matches.length === 0) return null;
  if (judgment.consequence >= policy.alertThreshold) {
    return { reason: "direct", score: judgment.consequence, targetKey: judgment.matches[0]?.targetKey ?? null };
  }
  if (judgment.consequence < policy.weakSignalFloor) return null;
  let best: AlertDecision | null = null;
  for (const m of judgment.matches) {
    const total = (priorWeakSums.get(m.targetKey) ?? 0) + judgment.consequence;
    if (total >= policy.accumulationThreshold && (!best || total > best.score)) {
      best = { reason: "accumulated", score: Math.round(total * 1000) / 1000, targetKey: m.targetKey };
    }
  }
  return best;
}

export interface AlertPayload {
  type: "mimir.alert";
  alert: Alert;
  observation: Observation;
  judgment: Judgment;
  source: { id: string; name: string; type: string };
}

export function buildPayload(alert: Alert, observation: Observation, judgment: Judgment, source: Source): AlertPayload {
  return {
    type: "mimir.alert",
    alert,
    observation,
    judgment,
    source: { id: source.id, name: source.name, type: source.type },
  };
}

export async function deliverWebhook(url: string, payload: AlertPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

/** ntfy priority: 5 (urgent) for very strong direct alerts, 4 for direct, 3 for accumulated. */
export function ntfyPriority(alert: Pick<Alert, "reason" | "score">): number {
  if (alert.reason === "accumulated") return 3;
  return alert.score >= 0.85 ? 5 : 4;
}

/** Push an alert to a phone via ntfy (https://ntfy.sh) using its JSON publish API. */
export async function deliverNtfy(ntfy: NtfyConfig, payload: AlertPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { alert, observation, judgment, source } = payload;
  const targets = judgment.matches.map((m) => m.name).join(", ");
  const headline = alert.reason === "direct" ? "Direct" : "Accumulated weak signals";
  const message = [`${headline} (${alert.score}) · ${judgment.eventType} · ${targets}`, judgment.rationale, `via ${source.name}`]
    .filter(Boolean)
    .join("\n");
  const res = await fetchImpl(ntfy.url.replace(/\/$/, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}) },
    body: JSON.stringify({
      topic: ntfy.topic,
      title: observation.title.slice(0, 250),
      message,
      priority: ntfyPriority(alert),
      tags: [alert.reason === "direct" ? "rotating_light" : "chart_with_upwards_trend"],
      ...(observation.url ? { click: observation.url } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

/** iOS interruption level: time-sensitive (breaks through Focus) for very strong direct alerts. */
export function barkLevel(alert: Pick<Alert, "reason" | "score">): "timeSensitive" | "active" {
  return alert.reason === "direct" && alert.score >= 0.85 ? "timeSensitive" : "active";
}

/**
 * Push an alert to an iPhone via Bark (https://bark.day.app). `barkUrl` is the
 * device URL shown in the Bark app, e.g. https://api.day.app/<device key>.
 */
export async function deliverBark(barkUrl: string, payload: AlertPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { alert, observation, judgment, source } = payload;
  const targets = judgment.matches.map((m) => m.name).join(", ");
  const headline = alert.reason === "direct" ? "Direct" : "Accumulated weak signals";
  const res = await fetchImpl(barkUrl.replace(/\/+$/, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      title: observation.title.slice(0, 250),
      subtitle: `${headline} (${alert.score}) · ${targets}`,
      body: [judgment.rationale, `via ${source.name}`].filter(Boolean).join("\n"),
      level: barkLevel(alert),
      group: "Mimir",
      ...(observation.url ? { url: observation.url } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Bark HTTP ${res.status}`);
}
