// Groups observations into events (one real-world development reported by many outlets) and decides which of an
// item's pillar impacts are new. Exact copies never get here (preprocess dedupes them); a local embedding model finds
// similar open events for free; the model, in the call it already makes per item, decides the ambiguous cases.
import { splitOutlet } from "./alerts.js";
import type { EventSummary, Store } from "./db.js";
import { isMajor, type Impact, type ImpactDraft, type JudgmentDraftLike, type Observation, type Source } from "./types.js";

export interface Embedder {
  name: string;
  /** Unit-length vector, so cosine similarity is a dot product. */
  embed(text: string): Promise<Float32Array>;
}

export const GROUPING = {
  /** Events still open for new reports. */
  windowHours: 72,
  /** Similar events at or above this are offered to the model as candidates. */
  similarMin: 0.6,
  /** Without a model verdict (backlog, first polls, model errors), merge only near-identical reports. */
  autoMergeMin: 0.9,
  maxSimilar: 3,
  /** Recently alerted events are always offered, since rewrites can share few words ("Alphabet" vs "Google"). */
  alertedWindowHours: 48,
  maxAlerted: 5,
};

/** Local sentence-embedding model (~25 MB, downloaded on first use, ~3 ms per headline on one CPU). */
export function createLocalEmbedder(model = "Xenova/all-MiniLM-L6-v2"): Embedder {
  type Extractor = (text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>;
  let extractor: Promise<Extractor> | undefined;
  return {
    name: model,
    async embed(text) {
      extractor ??= import("@huggingface/transformers").then(
        async (t) => (await t.pipeline("feature-extraction", model, { dtype: "q8" })) as unknown as Extractor,
      );
      const out = await (await extractor)(text, { pooling: "mean", normalize: true });
      return Float32Array.from(out.data);
    },
  };
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** What gets embedded: the bare headline for Google News (its summaries repeat it), else headline plus summary start. */
export function embedText(o: Pick<Observation, "title" | "summary">, source: Pick<Source, "name" | "type">): string {
  const { title } = splitOutlet(o.title, source);
  return source.type === "google-news" || !o.summary ? title : `${title}. ${o.summary.slice(0, 300)}`;
}

/** In-memory similarity index over open events' reports, loaded from the store on first use. */
export class EventIndex {
  private entries: { eventId: string; vector: Float32Array; at: number }[] = [];
  private loaded = false;

  constructor(readonly embedder: Embedder) {}

  /** Forget everything (replay starts from an empty store). */
  reset(): void {
    this.entries = [];
    this.loaded = false;
  }

  async load(store: Store, nowMs: number): Promise<void> {
    if (this.loaded) return;
    const since = new Date(nowMs - GROUPING.windowHours * 3600_000).toISOString();
    this.entries = (await store.eventVectorsSince(since)).map((r) => ({ eventId: r.eventId, vector: r.vector, at: Date.parse(r.at) }));
    this.loaded = true;
  }

  add(eventId: string, vector: Float32Array, atMs: number): void {
    this.entries.push({ eventId, vector, at: atMs });
  }

  /** Best similarity per open event. */
  search(vector: Float32Array, nowMs: number): Map<string, number> {
    const cutoff = nowMs - GROUPING.windowHours * 3600_000;
    this.entries = this.entries.filter((e) => e.at > cutoff);
    const best = new Map<string, number>();
    for (const e of this.entries) {
      const sim = similarity(vector, e.vector);
      if (sim > (best.get(e.eventId) ?? -1)) best.set(e.eventId, sim);
    }
    return best;
  }
}

export interface EventCandidate extends EventSummary {
  similarity: number;
  alerted: boolean;
}

/** Open events this item might report on: the most similar ones plus anything alerted on recently. */
export async function findCandidates(store: Store, index: EventIndex, vector: Float32Array, nowMs: number): Promise<EventCandidate[]> {
  await index.load(store, nowMs);
  const sims = index.search(vector, nowMs);
  const similar = [...sims]
    .filter(([, sim]) => sim >= GROUPING.similarMin)
    .sort((a, b) => b[1] - a[1])
    .slice(0, GROUPING.maxSimilar)
    .map(([id]) => id);
  const alerted = (await store.alertedEventIdsSince(new Date(nowMs - GROUPING.alertedWindowHours * 3600_000).toISOString())).slice(
    0,
    GROUPING.maxAlerted,
  );
  const ids = [...new Set([...similar, ...alerted])];
  return (await store.eventSummaries(ids)).map((e) => ({ ...e, similarity: sims.get(e.id) ?? 0, alerted: alerted.includes(e.id) }));
}

/**
 * The impacts an item adds to its event: pillars the event hadn't moved yet, or a slight move becoming major.
 * Another report of the same development adds nothing, so rewrites never count twice or alert again.
 */
export function newImpacts(existing: Pick<ImpactDraft, "tradeId" | "pillarId" | "effect">[], drafts: ImpactDraft[]): ImpactDraft[] {
  const added: ImpactDraft[] = [];
  for (const d of drafts) {
    const prior = [...existing, ...added].filter((e) => e.tradeId === d.tradeId && e.pillarId === d.pillarId);
    if (prior.length === 0 || (isMajor(d.effect) && !prior.some((p) => isMajor(p.effect)))) added.push(d);
  }
  return added;
}

export interface Placement {
  eventId: string;
  /** The open event the item joined, or null when it started a new one. */
  joined: EventCandidate | null;
  /** Impacts this item added to the event. */
  added: Impact[];
}

/**
 * Attach an observation to an event: the one the model named, else (no model verdict) a near-identical one,
 * else a new event. Then record whatever impacts are new to that event.
 */
export async function placeInEvent(
  store: Store,
  index: EventIndex,
  item: { observationId: string; title: string; judgment: JudgmentDraftLike; vector: Float32Array | null; candidates: EventCandidate[] },
  at: string,
  nowMs: number,
): Promise<Placement> {
  const { judgment, candidates, vector } = item;
  const verdict = judgment.event;
  const joined = verdict
    ? (candidates.find((c) => c.id === verdict.sameAs) ?? null)
    : (candidates.filter((c) => c.similarity >= GROUPING.autoMergeMin).sort((a, b) => b.similarity - a.similarity)[0] ?? null);
  const eventId =
    joined?.id ??
    (await store.createEvent({ title: verdict?.title ?? item.title, type: judgment.eventType, entities: verdict?.entities ?? [], firstSeenAt: at })).id;
  await store.addEventSource(eventId, item.observationId, joined ? (verdict ? "model" : "similar") : "new", joined ? joined.similarity : null, vector, at);
  if (vector) index.add(eventId, vector, nowMs);
  const existing = joined ? await store.eventImpacts(eventId) : [];
  const added: Impact[] = [];
  for (const d of newImpacts(existing, judgment.impacts ?? [])) {
    added.push(await store.insertImpact({ ...d, eventId, observationId: item.observationId, createdAt: at }));
  }
  return { eventId, joined, added };
}
