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

export interface Watchlist {
  themes: Theme[];
  entities: Entity[];
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
  /** `theme:<id>` or `entity:<id>` */
  targetKey: string;
  name: string;
  strength: number;
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
