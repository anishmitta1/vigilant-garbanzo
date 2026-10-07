export interface Theme {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  preset: boolean;
  createdAt: string;
}

export type EntityKind = "ticker" | "company" | "person" | "project" | "regulation" | "other";

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  createdAt: string;
}

/** Whether an item makes a tracked trade's thesis more or less likely to play out. */
export type Direction = "strengthens" | "weakens" | "mixed";

/** How an event moves one of a trade's pillars. */
export type Effect = "slightly_supports" | "majorly_supports" | "slightly_falsifies" | "majorly_falsifies";

export const EFFECTS: readonly Effect[] = ["slightly_supports", "majorly_supports", "slightly_falsifies", "majorly_falsifies"];

export const isMajor = (effect: Effect): boolean => effect.startsWith("majorly");

/** An example of the kind of event that would move a pillar, and how much. */
export interface Signal {
  id: string;
  description: string;
  effect: Effect;
}

/** An axiom the trade rests on, e.g. "AI capex compounds." Written by a person; the model only scores against it. */
export interface Pillar {
  id: string;
  tradeId: string;
  statement: string;
  signals: Signal[];
  active: boolean;
  createdAt: string;
}

/** A company, agency or person the trade depends on, under every name it appears as. */
export interface TradeEntity {
  name: string;
  aliases: string[];
}

/** A popular narrative trade, e.g. "AI infra buildout", tracked against explicit pillars. */
export interface Trade {
  id: string;
  name: string;
  thesis: string;
  entities: TradeEntity[];
  pillars: Pillar[];
  /** Terms that make an item relevant to the trade (case-insensitive). */
  keywords: string[];
  /** Symbols in the trade's basket (case-sensitive, `$` prefix allowed). */
  tickers: string[];
  /** Phrases the offline heuristic uses to guess direction when the model is unavailable. */
  strengthens: string[];
  weakens: string[];
  preset: boolean;
  createdAt: string;
}

export interface Watchlist {
  themes: Theme[];
  entities: Entity[];
  trades: Trade[];
}

export interface Source {
  id: string;
  type: string;
  name: string;
  config: unknown;
  enabled: boolean;
  weight: number;
  pollIntervalSeconds: number | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** An item as returned by a source adapter, before normalization. */
export interface RawItem {
  externalId: string;
  title: string;
  url?: string;
  summary?: string;
  publishedAt?: string;
  raw?: unknown;
}

export interface Observation {
  id: string;
  sourceId: string;
  externalId: string;
  url: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
  fetchedAt: string;
  urlHash: string | null;
  titleHash: string;
}

export interface TargetMatch {
  /** `theme:<id>`, `entity:<id>` or `trade:<id>` */
  targetKey: string;
  name: string;
  strength: number;
  /** Set for trades when the item pushes the thesis one way. */
  direction?: Direction;
}

export interface Judgment {
  id: string;
  observationId: string;
  scorer: string;
  eventType: string;
  consequence: number;
  urgency: number;
  matches: TargetMatch[];
  rationale: string;
  /** LLM verdict: would a PM on a tracked trade change their view? Undefined for heuristic judgments. */
  material?: boolean;
  /** The model's grouping call: same development as a candidate event, or a new one. */
  event?: EventVerdict;
  /** How the item moves each trade's pillars (pillarId null: relevant to the trade but fits no pillar). */
  impacts?: ImpactDraft[];
  /** Why an eligible-looking item didn't alert: backlog, a source's first poll, a target cooldown, a story already alerted, or screened out by triage. */
  held?: HeldReason;
  createdAt: string;
}

export type HeldReason = "stale" | "baseline" | "cooldown" | "same_story" | "same_event" | "triaged";

export interface EventVerdict {
  /** Id of the candidate event this item reports on, or null for a new development. */
  sameAs: string | null;
  title: string;
  entities: string[];
}

export interface ImpactDraft {
  tradeId: string;
  pillarId: string | null;
  effect: Effect;
  signalId: string | null;
  rationale: string;
}

/** One real-world development, reported by one or more observations. */
export interface MimirEvent {
  id: string;
  title: string;
  type: string;
  entities: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The parts of a judgment event placement reads. */
export type JudgmentDraftLike = Pick<Judgment, "eventType" | "event" | "impacts">;

export interface Impact extends ImpactDraft {
  id: string;
  eventId: string;
  observationId: string;
  createdAt: string;
}

export type AlertReason = "direct" | "accumulated";

export interface Alert {
  id: string;
  observationId: string;
  judgmentId: string;
  eventId?: string | null;
  reason: AlertReason;
  score: number;
  targetKey: string | null;
  delivered: boolean;
  deliveryError: string | null;
  createdAt: string;
}
