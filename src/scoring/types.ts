import type { PillarEvidence } from "../db.js";
import type { EventCandidate } from "../events.js";
import type { Judgment, Observation, Source, Watchlist } from "../types.js";

export type JudgmentDraft = Omit<Judgment, "id" | "observationId" | "createdAt">;

/** What the scorer knows beyond the item: open events it might belong to and recent evidence per pillar. */
export interface JudgeContext {
  candidates?: EventCandidate[];
  /** Newest first. */
  evidence?: PillarEvidence[];
}

export interface Scorer {
  name: string;
  judge(observation: Observation, source: Source, watchlist: Watchlist, context?: JudgeContext): Promise<JudgmentDraft>;
}
