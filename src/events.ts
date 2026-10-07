// Groups observations into events (one real-world development reported by many outlets) and decides which of an
// item's pillar impacts are new. Exact copies never get here (preprocess dedupes them); a local embedding model finds
// similar open events for free; the model, in the call it already makes per item, decides the ambiguous cases.
import { splitOutlet } from "./alerts.js";
import type { EventSummary, Store } from "./db.js";
import type { Scorer } from "./scoring/types.js";
import { isMajor, type Impact, type ImpactDraft, type JudgmentDraftLike, type Observation, type Source } from "./types.js";
import { errorMessage } from "./util.js";

export interface Embedder {
  name: string;
  /** Unit-length vector, so cosine similarity is a dot product. */
  embed(text: string): Promise<Float32Array>;
}

export const GROUPING = {
  /** Events still open for new reports. */
  windowHours: 72,
  /** Without a model verdict (backlog, first polls, model errors), merge only near-identical reports. */
  autoMergeMin: 0.9,
  maxSimilar: 3,
  /** Recently alerted events are always offered, since rewrites can share few words ("Alphabet" vs "Google"). */
  alertedWindowHours: 48,
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
export async function findCandidates(store: Store, index: EventIndex, vector: Float32Array | null, nowMs: number): Promise<EventCandidate[]> {
  if (vector) await index.load(store, nowMs);
  const sims = vector ? index.search(vector, nowMs) : new Map<string, number>();
  const similar = [...sims]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GROUPING.maxSimilar)
    .map(([id]) => id);
  const alerted = await store.alertedEventIdsSince(new Date(nowMs - GROUPING.alertedWindowHours * 3600_000).toISOString());
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
  // sameAs identifies a re-report, not an independent development. It cannot add evidence by re-rating it.
  for (const d of newImpacts(existing, joined ? [] : (judgment.impacts ?? []))) {
    added.push(await store.insertImpact({ ...d, eventId, observationId: item.observationId, createdAt: at }));
  }
  return { eventId, joined, added };
}

/** Silently seed event memory from pre-event-layer pushes. Existing delivery records are never changed. */
export async function warmEventMemory(store: Store, index: EventIndex, scorer: Scorer, nowMs: number, log?: (msg: string) => void): Promise<void> {
  const since = new Date(nowMs - GROUPING.alertedWindowHours * 3600_000).toISOString();
  const observations = await store.unlinkedAlertObservations(since);
  if (observations.length === 0) return;
  log?.(`warming event memory from ${observations.length} prior pushed items (no delivery)`);
  const watchlist = { trades: await store.listTrades(), themes: await store.listThemes(), entities: await store.listEntities() };
  let fallbacks = 0;
  for (const o of observations) {
    const existing = await store.eventIdForObservation(o.id);
    if (existing) {
      await store.linkAlertsToEvent(o.id, existing);
      continue;
    }
    const source = await store.getSource(o.sourceId);
    if (!source) continue;
    let vector: Float32Array | null = null;
    try {
      vector = await index.embedder.embed(embedText(o, source));
    } catch (err) {
      log?.(`event embedding failed: ${errorMessage(err)}`);
    }
    const candidates = await findCandidates(store, index, vector, nowMs);
    const evidence = await store.impactsSince(new Date(nowMs - 14 * 86_400_000).toISOString());
    const judgment = await scorer.judge(o, source, watchlist, { candidates, evidence });
    if (scorer.name.startsWith("llm:") && !judgment.scorer.startsWith("llm:")) {
      fallbacks++;
      log?.(`event memory model verdict unavailable for ${o.id}; using local fallback`);
    }
    const placed = await placeInEvent(store, index, { observationId: o.id, title: o.title, judgment, vector, candidates }, o.fetchedAt, Date.parse(o.fetchedAt));
    await store.linkAlertsToEvent(o.id, placed.eventId);
  }
  log?.(fallbacks > 0 ? `event memory linked with ${fallbacks} local fallbacks; impact history may be incomplete` : "event memory ready");
}
