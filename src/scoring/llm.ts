import { z } from "zod";
import type { Config } from "../config.js";
import { EFFECTS, type Direction, type EventVerdict, type ImpactDraft, type Observation, type Source, type Watchlist } from "../types.js";
import { clamp01, errorMessage } from "../util.js";
import { heuristicScorer } from "./heuristic.js";
import type { JudgeContext, JudgmentDraft, Scorer } from "./types.js";

const ImpactSchema = z.object({
  trade: z.string(),
  pillar: z.string().nullish(),
  effect: z.enum(EFFECTS as [string, ...string[]]),
  signal: z.string().nullish(),
  rationale: z.string().default(""),
});

const ResponseSchema = z.object({
  event_type: z.string(),
  consequence: z.number(),
  urgency: z.number(),
  matched_targets: z.array(z.string()),
  directions: z.record(z.string(), z.enum(["strengthens", "weakens", "mixed", "neutral"])).optional(),
  rationale: z.string(),
  material: z.boolean().optional(),
  same_event: z.string().nullish(),
  event_title: z.string().nullish(),
  event_entities: z.array(z.string()).nullish(),
  // One malformed impact shouldn't discard the whole verdict.
  impacts: z.array(z.unknown()).nullish(),
});

const SYSTEM_PROMPT = `You are a fast triage model for an investor alerting system.
Decide whether a news item MATERIALLY CHANGES something the investor tracks, not merely whether it is related.
Some targets are trades: a thesis resting on pillars, axioms the trade assumes. Each pillar lists example signals with their effect.
Respond with JSON: {"material": boolean, "event_type": string, "consequence": 0..1, "urgency": 0..1, "matched_targets": [target keys], "impacts": [{"trade": trade key, "pillar": pillar id or null, "effect": "slightly_supports"|"majorly_supports"|"slightly_falsifies"|"majorly_falsifies", "signal": signal id or null, "rationale": short}], "same_event": open event id or null, "event_title": string, "event_entities": [names], "rationale": one sentence}.
material=true ONLY if a portfolio manager running one of the tracked trades would plausibly change their view, sizing or risk because of this item. Typical material items: an official decision or action (rate decision, executive order, tariff action, export control, final or proposed rule, license or approval that changes an industry), legislation advancing or failing, a binding deal or contract, a guidance or capex change, a surprise data print, enforcement that changes market structure.
material=false for routine or low-signal items: meetings, conferences, comment-period extensions, minor bank approvals, individual fraud cases, commentary, opinion, explainers, daily price recaps, product or wallet launches, local disputes, listicles, and stories that merely mention a trade's keywords. When in doubt, material=false.
consequence ~0 for irrelevant or routine items, >0.6 only for material developments.
impacts: for each trade the item actually moves, the pillar it moves and how. Signals are calibration examples, not an exhaustive list; set "signal" only on a clear match. "majorly" means a PM would act on it now; slight moves are worth recording but not acting on. Weigh each pillar's recent evidence: the same development is not new evidence, but a further independent move the same way can be major when the pillar has already been moving. Use pillar null when the item matters to the trade but fits none of its pillars. Omit trades it doesn't move; [] if none.
open_events are developments already being tracked. Set same_event to the one this item reports on: the same real-world development, even if worded differently, from another outlet, or naming a company differently (Google/Alphabet). A follow-up with materially new facts (a new decision, a reversal, a different deal) is a new development: same_event null. If the item only re-reports an open event, material=false and impacts [].
event_title: a short neutral title for the development; event_entities: its main companies, agencies or people.
For trades, say in the rationale what changed and which pillar it moves.`;

const EVIDENCE_DAYS = 14;
const EVIDENCE_PER_PILLAR = 3;

/**
 * System-1 scorer backed by any OpenAI-compatible chat completions API.
 * Falls back to the heuristic scorer on any error so a model outage never drops items.
 */
export function createLlmScorer(llm: NonNullable<Config["llm"]>, fetchImpl: typeof fetch = fetch): Scorer {
  return {
    name: `llm:${llm.model}`,
    async judge(observation: Observation, source: Source, watchlist: Watchlist, context: JudgeContext = {}): Promise<JudgmentDraft> {
      const baseline = await heuristicScorer.judge(observation, source, watchlist);
      // Short ids keep the prompt small: pillars P1.., signals P1.2.., events E1..
      const pillarAlias = new Map<string, { tradeId: string; pillarId: string; signals: Set<string> }>();
      const evidenceSince = Date.parse(observation.fetchedAt || new Date().toISOString()) - EVIDENCE_DAYS * 86_400_000;
      const evidence = (context.evidence ?? []).filter((e) => Date.parse(e.createdAt) > evidenceSince);
      const day = (iso: string) => iso.slice(0, 10);
      const targets = [
        ...watchlist.themes.map((t) => ({ key: `theme:${t.id}`, name: t.name, description: t.description })),
        ...watchlist.entities.map((e) => ({ key: `entity:${e.id}`, name: e.name, kind: e.kind, aliases: e.aliases })),
        ...watchlist.trades.map((t) => ({
          key: `trade:${t.id}`,
          name: t.name,
          thesis: t.thesis,
          tickers: t.tickers,
          ...(t.entities.length > 0
            ? { entities: t.entities.map((e) => (e.aliases.length > 0 ? `${e.name} (${e.aliases.join(", ")})` : e.name)) }
            : {}),
          ...(t.pillars.some((p) => p.active)
            ? {
                pillars: t.pillars
                  .filter((p) => p.active)
                  .map((p) => {
                    const id = `P${pillarAlias.size + 1}`;
                    pillarAlias.set(id, { tradeId: t.id, pillarId: p.id, signals: new Set(p.signals.map((s) => `${id}.${s.id}`)) });
                    const recent = evidence
                      .filter((e) => e.pillarId === p.id)
                      .slice(0, EVIDENCE_PER_PILLAR)
                      .map((e) => `${day(e.createdAt)} ${e.effect}: ${e.eventTitle}`);
                    return {
                      id,
                      axiom: p.statement,
                      signals: p.signals.map((s) => ({ id: `${id}.${s.id}`, effect: s.effect, example: s.description })),
                      ...(recent.length > 0 ? { recent_evidence: recent } : {}),
                    };
                  }),
              }
            : { strengthened_by: t.strengthens, weakened_by: t.weakens }),
        })),
      ];
      const candidates = (context.candidates ?? []).map((c, i) => ({ alias: `E${i + 1}`, c }));
      try {
        const res = await fetchImpl(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            model: llm.model,
            temperature: 0,
            ...(llm.maxTokens ? { max_tokens: llm.maxTokens } : {}),
            ...(llm.reasoning
              ? { reasoning: llm.reasoning === "off" ? { enabled: false } : { effort: llm.reasoning } }
              : {}),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  tracked_targets: targets,
                  open_events: candidates.map(({ alias, c }) => ({
                    id: alias,
                    title: c.title,
                    first_seen: c.firstSeenAt,
                    reports: c.items,
                    ...(c.alerted ? { already_alerted: true } : {}),
                  })),
                  item: {
                    source: source.name,
                    title: observation.title,
                    summary: observation.summary,
                    published_at: observation.publishedAt,
                  },
                  heuristic_hint: { event_type: baseline.eventType, matches: baseline.matches },
                }),
              },
            ],
          }),
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const parsed = ResponseSchema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? ""));
        const nameByKey = new Map(targets.map((t) => [t.key, t.name]));

        const tradeIds = new Set(watchlist.trades.map((t) => t.id));
        const impacts: ImpactDraft[] = [];
        for (const raw of parsed.impacts ?? []) {
          const r = ImpactSchema.safeParse(raw);
          if (!r.success) continue;
          const tradeId = r.data.trade.replace(/^trade:/, "");
          if (!tradeIds.has(tradeId)) continue;
          const pillar = r.data.pillar ? pillarAlias.get(r.data.pillar) : undefined;
          const onTrade = pillar?.tradeId === tradeId ? pillar : undefined;
          const signal = onTrade && r.data.signal && onTrade.signals.has(r.data.signal) ? r.data.signal.split(".")[1]! : null;
          impacts.push({
            tradeId,
            pillarId: onTrade?.pillarId ?? null,
            effect: r.data.effect as ImpactDraft["effect"],
            signalId: signal,
            rationale: r.data.rationale,
          });
        }
        const sameAs = candidates.find((c) => c.alias === parsed.same_event)?.c.id ?? null;
        const event: EventVerdict = {
          sameAs,
          title: parsed.event_title?.trim() || observation.title,
          entities: parsed.event_entities ?? [],
        };

        const keys = [...new Set([...parsed.matched_targets, ...impacts.map((i) => `trade:${i.tradeId}`)])];
        return {
          scorer: this.name,
          eventType: parsed.event_type,
          consequence: clamp01(parsed.consequence),
          urgency: clamp01(parsed.urgency),
          matches: keys
            .filter((k) => nameByKey.has(k))
            .map((k) => {
              const direction = directionFromImpacts(impacts, k) ?? parsed.directions?.[k];
              return {
                targetKey: k,
                name: nameByKey.get(k) ?? k,
                strength: 1,
                ...(direction && direction !== "neutral" ? { direction } : {}),
              };
            }),
          rationale: parsed.rationale,
          material: parsed.material === true,
          event,
          impacts,
        };
      } catch (err) {
        return { ...baseline, rationale: `${baseline.rationale} (LLM fallback: ${errorMessage(err)})` };
      }
    },
  };
}

function directionFromImpacts(impacts: ImpactDraft[], targetKey: string): Direction | undefined {
  const effects = impacts.filter((i) => `trade:${i.tradeId}` === targetKey).map((i) => i.effect);
  if (effects.length === 0) return undefined;
  const up = effects.some((e) => e.endsWith("supports"));
  const down = effects.some((e) => e.endsWith("falsifies"));
  return up && down ? "mixed" : up ? "strengthens" : "weakens";
}
