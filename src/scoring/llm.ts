import { z } from "zod";
import type { Config } from "../config.js";
import type { Observation, Source, Watchlist } from "../types.js";
import { clamp01, errorMessage } from "../util.js";
import { heuristicScorer } from "./heuristic.js";
import type { JudgmentDraft, Scorer } from "./types.js";

const ResponseSchema = z.object({
  event_type: z.string(),
  consequence: z.number(),
  urgency: z.number(),
  matched_targets: z.array(z.string()),
  directions: z.record(z.string(), z.enum(["strengthens", "weakens", "mixed", "neutral"])).optional(),
  rationale: z.string(),
  material: z.boolean().optional(),
});

/** High-volume sources whose items only reach the model if the heuristic matched a tracked target. */
const AGGREGATOR_TYPES = new Set(["google-news", "hackernews", "reddit", "sec-edgar"]);

const SYSTEM_PROMPT = `You are a fast triage model for an investor alerting system.
Decide whether a news item MATERIALLY CHANGES something the investor tracks, not merely whether it is related.
Some targets are popular trades with a thesis plus signals that strengthen or weaken it.
Respond with JSON: {"material": boolean, "event_type": string, "consequence": 0..1, "urgency": 0..1, "matched_targets": [target keys], "directions": {trade target key: "strengthens"|"weakens"|"mixed"|"neutral"}, "rationale": one sentence}.
material=true ONLY if a portfolio manager running one of the tracked trades would plausibly change their view, sizing or risk because of this item. Typical material items: an official decision or action (rate decision, executive order, tariff action, export control, final or proposed rule, license or approval that changes an industry), legislation advancing or failing, a binding deal or contract, a guidance or capex change, a surprise data print, enforcement that changes market structure.
material=false for routine or low-signal items: meetings, conferences, comment-period extensions, minor bank approvals, individual fraud cases, commentary, opinion, explainers, daily price recaps, product or wallet launches, local disputes, listicles, and stories that merely mention a trade's keywords. When in doubt, material=false.
consequence ~0 for irrelevant or routine items, >0.6 only for material developments.
For trades, say in the rationale what changed and which way it pushes the trade.`;

/**
 * System-1 scorer backed by any OpenAI-compatible chat completions API.
 * Falls back to the heuristic scorer on any error so a model outage never drops items.
 */
export function createLlmScorer(llm: NonNullable<Config["llm"]>, fetchImpl: typeof fetch = fetch): Scorer {
  const usage = { day: "", calls: 0 };
  return {
    name: `llm:${llm.model}`,
    async judge(observation: Observation, source: Source, watchlist: Watchlist): Promise<JudgmentDraft> {
      const baseline = await heuristicScorer.judge(observation, source, watchlist);
      if (AGGREGATOR_TYPES.has(source.type) && baseline.matches.length === 0) return baseline;
      const today = new Date().toISOString().slice(0, 10);
      if (usage.day !== today) Object.assign(usage, { day: today, calls: 0 });
      if (llm.maxCallsPerDay !== undefined && usage.calls >= llm.maxCallsPerDay) {
        return { ...baseline, rationale: `${baseline.rationale} (LLM daily cap reached)` };
      }
      usage.calls++;
      const targets = [
        ...watchlist.themes.map((t) => ({ key: `theme:${t.id}`, name: t.name, description: t.description })),
        ...watchlist.entities.map((e) => ({ key: `entity:${e.id}`, name: e.name, kind: e.kind, aliases: e.aliases })),
        ...watchlist.trades.map((t) => ({
          key: `trade:${t.id}`,
          name: t.name,
          thesis: t.thesis,
          tickers: t.tickers,
          strengthened_by: t.strengthens,
          weakened_by: t.weakens,
        })),
      ];
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
        return {
          scorer: this.name,
          eventType: parsed.event_type,
          consequence: clamp01(parsed.consequence),
          urgency: clamp01(parsed.urgency),
          matches: parsed.matched_targets
            .filter((k) => nameByKey.has(k))
            .map((k) => {
              const direction = parsed.directions?.[k];
              return {
                targetKey: k,
                name: nameByKey.get(k) ?? k,
                strength: 1,
                ...(direction && direction !== "neutral" ? { direction } : {}),
              };
            }),
          rationale: parsed.rationale,
          material: parsed.material === true,
        };
      } catch (err) {
        return { ...baseline, rationale: `${baseline.rationale} (LLM fallback: ${errorMessage(err)})` };
      }
    },
  };
}
