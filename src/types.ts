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

/** A popular narrative trade, e.g. "AI infra buildout", tracked with explicit thesis signals. */
export interface Trade {
  id: string;
  name: string;
  thesis: string;
  /** Terms that make an item relevant to the trade (case-insensitive). */
  keywords: string[];
  /** Symbols in the trade's basket (case-sensitive, `$` prefix allowed). */
  tickers: string[];
  /** Phrases that, on a relevant item, indicate the thesis is strengthening / weakening. */
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
  createdAt: string;
}

export type AlertReason = "direct" | "accumulated";

export interface Alert {
  id: string;
  observationId: string;
  judgmentId: string;
  reason: AlertReason;
  score: number;
  targetKey: string | null;
  delivered: boolean;
  deliveryError: string | null;
  createdAt: string;
}
