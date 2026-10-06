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
