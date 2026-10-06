import type { Judgment, Observation, Source, Watchlist } from "../types.js";

export type JudgmentDraft = Omit<Judgment, "id" | "observationId" | "createdAt">;

export interface Scorer {
  name: string;
  judge(observation: Observation, source: Source, watchlist: Watchlist): Promise<JudgmentDraft>;
}
