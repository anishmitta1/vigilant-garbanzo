import type { Entity, Observation, Source, TargetMatch, Theme, Watchlist } from "../types.js";
import { clamp01 } from "../util.js";
import type { JudgmentDraft, Scorer } from "./types.js";

/**
 * Event classes ordered by how much they tend to change an investor's view.
 * `weight` is the base consequence of the event class; `urgency` how time-sensitive it is.
 */
export const EVENT_CLASSES: { type: string; weight: number; urgency: number; patterns: RegExp[] }[] = [
  { type: "bankruptcy", weight: 0.95, urgency: 0.95, patterns: [/\bbankrupt(cy)?\b/, /\bchapter 11\b/, /\binsolven/, /\bdefault(s|ed)? on\b/] },
  { type: "rate_decision", weight: 0.9, urgency: 0.9, patterns: [/\brate (hike|cut|increase|decrease)s?\b/, /\bfomc\b/, /\bbasis points?\b/, /\bholds? rates?\b/] },
  { type: "guidance_change", weight: 0.85, urgency: 0.8, patterns: [/\b(raises?|cuts?|lowers?|withdraws?|reaffirms?) (its |full[- ]year )?(guidance|outlook|forecast)\b/, /\bprofit warning\b/] },
  { type: "m_and_a", weight: 0.85, urgency: 0.8, patterns: [/\bacquir(e|es|ed|ing|ition)\b/, /\bmerger\b/, /\btakeover\b/, /\bbuyout\b/, /\bto buy\b/] },
  { type: "regulation", weight: 0.8, urgency: 0.75, patterns: [/\bexport (control|ban|restriction)s?\b/, /\bsanction(s|ed)?\b/, /\bban(s|ned)?\b/, /\bantitrust\b/, /\bfinal rule\b/, /\bproposed rule\b/, /\bexecutive order\b/, /\btariffs?\b/, /\bsec (charges|sues)\b/] },
  { type: "security_incident", weight: 0.75, urgency: 0.9, patterns: [/\bhack(ed|ers?)?\b/, /\bexploit(ed)?\b/, /\bbreach\b/, /\bdrained\b/, /\bdepeg/] },
  { type: "earnings", weight: 0.7, urgency: 0.7, patterns: [/\bearnings\b/, /\bquarterly results\b/, /\brevenue (beat|miss|rose|fell)\b/, /\b(q[1-4]|fy\d{2,4}) results\b/] },
  { type: "supply_chain", weight: 0.65, urgency: 0.6, patterns: [/\bshortage\b/, /\bcapacity\b/, /\bsupply (chain|cut|disruption)\b/, /\bfab\b/, /\bproduction (halt|cut)\b/] },
  { type: "executive_change", weight: 0.6, urgency: 0.6, patterns: [/\b(ceo|cfo|chair(man)?|founder) (resigns?|steps? down|departs?|fired|ousted)\b/, /\bnames? new (ceo|cfo)\b/, /\bappoint(s|ed)\b.*\b(ceo|cfo)\b/] },
  { type: "litigation", weight: 0.6, urgency: 0.5, patterns: [/\blawsuit\b/, /\bsues?\b/, /\bsettle(s|ment)\b/, /\bindict(ed|ment)\b/, /\bprobe\b/, /\binvestigation\b/] },
  { type: "capital_markets", weight: 0.55, urgency: 0.5, patterns: [/\bipo\b/, /\braises? \$/, /\bfunding round\b/, /\bshare (offering|buyback)\b/, /\bbuyback\b/, /\bdowngrade(d|s)?\b/, /\bupgrade(d|s)?\b/] },
  { type: "outage", weight: 0.55, urgency: 0.8, patterns: [/\boutage\b/, /\bdown for\b/, /\brecall(s|ed)?\b/] },
  { type: "filing", weight: 0.4, urgency: 0.4, patterns: [/\b(8-k|10-q|10-k|s-1|13d|13g|6-k|20-f)\b/] },
  { type: "product", weight: 0.35, urgency: 0.3, patterns: [/\blaunch(es|ed)?\b/, /\bunveil(s|ed)?\b/, /\breleases?\b/, /\bannounces?\b/] },
];

const GENERAL = { type: "general", weight: 0.2, urgency: 0.2 };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function termRegex(term: string, caseSensitive: boolean): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])\\$?${escapeRe(term)}(?=$|[^\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu");
}

export function classifyEvent(text: string): { type: string; weight: number; urgency: number } {
  const lower = text.toLowerCase();
  return EVENT_CLASSES.find((c) => c.patterns.some((p) => p.test(lower))) ?? GENERAL;
}

function matchEntity(entity: Entity, title: string, summary: string): number {
  // Tickers like "AMD" or "ARM" collide with ordinary words, so the symbol itself is case-sensitive.
  const regs = [
    termRegex(entity.name, entity.kind === "ticker"),
    ...entity.aliases.filter((a) => a.trim().length > 0).map((a) => termRegex(a, false)),
  ];
  if (regs.some((r) => r.test(title))) return 1;
  if (regs.some((r) => r.test(summary))) return 0.6;
  return 0;
}

function matchTheme(theme: Theme, title: string, summary: string): number {
  let score = 0;
  for (const kw of theme.keywords) {
    const r = termRegex(kw, false);
    if (r.test(title)) score += 0.5;
    else if (r.test(summary)) score += 0.25;
  }
  return clamp01(score);
}

export function matchTargets(watchlist: Watchlist, title: string, summary: string): TargetMatch[] {
  const matches: TargetMatch[] = [];
  for (const e of watchlist.entities) {
    const strength = matchEntity(e, title, summary);
    if (strength > 0) matches.push({ targetKey: `entity:${e.id}`, name: e.name, strength });
  }
  for (const t of watchlist.themes) {
    const strength = matchTheme(t, title, summary);
    if (strength > 0) matches.push({ targetKey: `theme:${t.id}`, name: t.name, strength });
  }
  return matches.sort((a, b) => b.strength - a.strength);
}

/** Deterministic, explainable System-1 baseline. */
export const heuristicScorer: Scorer = {
  name: "heuristic",
  async judge(observation: Observation, source: Source, watchlist: Watchlist): Promise<JudgmentDraft> {
    const matches = matchTargets(watchlist, observation.title, observation.summary);
    const event = classifyEvent(`${observation.title} ${observation.summary}`);
    const relevance = matches[0]?.strength ?? 0;
    // Several distinct tracked targets in one item is itself a signal.
    const breadth = Math.min(0.15, 0.05 * Math.max(0, matches.length - 1));
    const consequence = relevance === 0 ? 0 : clamp01((relevance * event.weight + breadth) * source.weight);
    return {
      scorer: "heuristic",
      eventType: event.type,
      consequence: round(consequence),
      urgency: round(relevance === 0 ? 0 : event.urgency),
      matches,
      rationale:
        matches.length === 0
          ? "No tracked theme or entity matched."
          : `${event.type} event (weight ${event.weight}) matching ${matches.map((m) => `${m.name} (${m.strength})`).join(", ")}; source weight ${source.weight}.`,
    };
  },
};

const round = (n: number): number => Math.round(n * 1000) / 1000;
