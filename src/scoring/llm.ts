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
  rationale: z.string(),
});

const SYSTEM_PROMPT = `You are a fast triage model for an investor alerting system.
Decide whether a news item MATERIALLY CHANGES something the investor tracks, not merely whether it is related.
Respond with JSON: {"event_type": string, "consequence": 0..1, "urgency": 0..1, "matched_targets": [target keys], "rationale": one sentence}.
consequence ~0 for irrelevant or routine items, >0.6 only for developments likely to change a position or thesis.`;

/**
 * System-1 scorer backed by any OpenAI-compatible chat completions API.
 * Falls back to the heuristic scorer on any error so a model outage never drops items.
 */
export function createLlmScorer(llm: NonNullable<Config["llm"]>, fetchImpl: typeof fetch = fetch): Scorer {
  return {
    name: `llm:${llm.model}`,
    async judge(observation: Observation, source: Source, watchlist: Watchlist): Promise<JudgmentDraft> {
      const baseline = await heuristicScorer.judge(observation, source, watchlist);
      const targets = [
        ...watchlist.themes.map((t) => ({ key: `theme:${t.id}`, name: t.name, description: t.description })),
        ...watchlist.entities.map((e) => ({ key: `entity:${e.id}`, name: e.name, kind: e.kind, aliases: e.aliases })),
      ];
      try {
        const res = await fetchImpl(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            model: llm.model,
            temperature: 0,
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
          consequence: clamp01(parsed.consequence * source.weight),
          urgency: clamp01(parsed.urgency),
          matches: parsed.matched_targets
            .filter((k) => nameByKey.has(k))
            .map((k) => ({ targetKey: k, name: nameByKey.get(k) ?? k, strength: 1 })),
          rationale: parsed.rationale,
        };
      } catch (err) {
        return { ...baseline, rationale: `${baseline.rationale} (LLM fallback: ${errorMessage(err)})` };
      }
    },
  };
}
