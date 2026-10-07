import { z } from "zod";
import type { Config } from "../config.js";
import type { Watchlist } from "../types.js";

/** Screens a batch of headlines in one call; true = worth the full judgment. */
export type Triage = (items: { title: string; summary: string }[], watchlist: Watchlist) => Promise<boolean[]>;

const BATCH = 50;
const SUMMARY_CHARS = 200;

const TRIAGE_PROMPT = `You screen press releases and filings for an investor who tracks the trades below.
For each numbered item, decide whether it could plausibly move any trade's thesis (support or undercut it), including items about companies, agencies or projects the trade doesn't name.
Drop items clearly unrelated to every trade: routine releases from unrelated companies, product promos, personnel, awards, conferences, fund and dividend notices, local business news. When unsure, keep.
Respond with JSON: {"keep": [numbers of items to keep]}.`;

const ResponseSchema = z.object({ keep: z.array(z.coerce.number()) });

/** Cheap batched pre-screen for high-volume sources. Fails open: on any error every item goes to the full judgment. */
export function createLlmTriage(llm: NonNullable<Config["llm"]>, fetchImpl: typeof fetch = fetch): Triage {
  return async (items, watchlist) => {
    const keep: boolean[] = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const res = await fetchImpl(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            model: llm.model,
            temperature: 0,
            ...(llm.reasoning ? { reasoning: llm.reasoning === "off" ? { enabled: false } : { effort: llm.reasoning } } : {}),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: TRIAGE_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  trades: watchlist.trades.map((t) => ({ name: t.name, thesis: t.thesis, tickers: t.tickers })),
                  watched: watchlist.entities.map((e) => e.name),
                  items: batch.map((it, n) => ({ n: n + 1, title: it.title, ...(it.summary ? { summary: it.summary.slice(0, SUMMARY_CHARS) } : {}) })),
                }),
              },
            ],
          }),
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const kept = new Set(ResponseSchema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? "")).keep);
        keep.push(...batch.map((_, n) => kept.has(n + 1)));
      } catch {
        keep.push(...batch.map(() => true));
      }
    }
    return keep;
  };
}
