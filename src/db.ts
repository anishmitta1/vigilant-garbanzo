import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import { accumulatingMatches } from "./alerts.js";
import type {
  Alert,
  AlertReason,
  Effect,
  Entity,
  EntityKind,
  HeldReason,
  Impact,
  Judgment,
  MimirEvent,
  Observation,
  Pillar,
  Signal,
  Source,
  Theme,
  Trade,
  TradeEntity,
} from "./types.js";
import { newId, nowIso } from "./util.js";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    preset INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    weight REAL NOT NULL DEFAULT 1,
    poll_interval_seconds INTEGER,
    last_run_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    url TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    url_hash TEXT,
    title_hash TEXT NOT NULL,
    raw TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_source_external ON observations(source_id, external_id)`,
  `CREATE INDEX IF NOT EXISTS observations_url_hash ON observations(url_hash)`,
  `CREATE INDEX IF NOT EXISTS observations_title_hash ON observations(title_hash)`,
  `CREATE TABLE IF NOT EXISTS judgments (
    id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    scorer TEXT NOT NULL,
    event_type TEXT NOT NULL,
    consequence REAL NOT NULL,
    urgency REAL NOT NULL,
    matches TEXT NOT NULL,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS judgment_targets (
    judgment_id TEXT NOT NULL REFERENCES judgments(id) ON DELETE CASCADE,
    target_key TEXT NOT NULL,
    consequence REAL NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS judgment_targets_key ON judgment_targets(target_key, created_at)`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    judgment_id TEXT NOT NULL REFERENCES judgments(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    score REAL NOT NULL,
    target_key TEXT,
    delivered INTEGER NOT NULL DEFAULT 0,
    delivery_error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS alerts_created ON alerts(created_at)`,
  `CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    thesis TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    tickers TEXT NOT NULL DEFAULT '[]',
    strengthens TEXT NOT NULL DEFAULT '[]',
    weakens TEXT NOT NULL DEFAULT '[]',
    preset INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pillars (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    statement TEXT NOT NULL,
    signals TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    entities TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_last_seen ON events(last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS event_sources (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    how TEXT NOT NULL,
    similarity REAL,
    embedding BLOB,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS event_sources_event ON event_sources(event_id)`,
  `CREATE INDEX IF NOT EXISTS event_sources_created ON event_sources(created_at)`,
  `CREATE TABLE IF NOT EXISTS impacts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    trade_id TEXT NOT NULL,
    pillar_id TEXT,
    effect TEXT NOT NULL,
    signal_id TEXT,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS impacts_event ON impacts(event_id)`,
  `CREATE INDEX IF NOT EXISTS impacts_created ON impacts(created_at)`,
];

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);
const s = (v: unknown): string => String(v);
const sOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toTheme(r: Row): Theme {
  return {
    id: s(r.id),
    name: s(r.name),
    description: s(r.description),
    keywords: parse<string[]>(r.keywords, []),
    preset: Number(r.preset) === 1,
    createdAt: s(r.created_at),
  };
}

function toTrade(r: Row): Trade {
  return {
    id: s(r.id),
    name: s(r.name),
    thesis: s(r.thesis),
    keywords: parse<string[]>(r.keywords, []),
    tickers: parse<string[]>(r.tickers, []),
    entities: parse<TradeEntity[]>(r.entities, []),
    pillars: [],
    strengthens: parse<string[]>(r.strengthens, []),
    weakens: parse<string[]>(r.weakens, []),
    preset: Number(r.preset) === 1,
    createdAt: s(r.created_at),
  };
}

function toPillar(r: Row): Pillar {
  return {
    id: s(r.id),
    tradeId: s(r.trade_id),
    statement: s(r.statement),
    signals: parse<Signal[]>(r.signals, []),
    active: Number(r.active) === 1,
    createdAt: s(r.created_at),
  };
}

function toEvent(r: Row): MimirEvent {
  return {
    id: s(r.id),
    title: s(r.title),
    type: s(r.type),
    entities: parse<string[]>(r.entities, []),
    firstSeenAt: s(r.first_seen_at),
    lastSeenAt: s(r.last_seen_at),
  };
}

function toImpact(r: Row): Impact {
  return {
    id: s(r.id),
    eventId: s(r.event_id),
    observationId: s(r.observation_id),
    tradeId: s(r.trade_id),
    pillarId: sOrNull(r.pillar_id),
    effect: s(r.effect) as Effect,
    signalId: sOrNull(r.signal_id),
    rationale: s(r.rationale),
    createdAt: s(r.created_at),
  };
}

function toEntity(r: Row): Entity {
  return {
    id: s(r.id),
    name: s(r.name),
    kind: s(r.kind) as EntityKind,
    aliases: parse<string[]>(r.aliases, []),
    createdAt: s(r.created_at),
  };
}

function toSource(r: Row): Source {
  return {
    id: s(r.id),
    type: s(r.type),
    name: s(r.name),
    config: parse<unknown>(r.config, {}),
    enabled: Number(r.enabled) === 1,
    weight: Number(r.weight),
    pollIntervalSeconds: r.poll_interval_seconds === null ? null : Number(r.poll_interval_seconds),
    lastRunAt: sOrNull(r.last_run_at),
    lastError: sOrNull(r.last_error),
    createdAt: s(r.created_at),
  };
}

function toObservation(r: Row): Observation {
  return {
    id: s(r.id),
    sourceId: s(r.source_id),
    externalId: s(r.external_id),
    url: sOrNull(r.url),
    title: s(r.title),
    summary: s(r.summary),
    publishedAt: sOrNull(r.published_at),
    fetchedAt: s(r.fetched_at),
    urlHash: sOrNull(r.url_hash),
    titleHash: s(r.title_hash),
  };
}

function toJudgment(r: Row): Judgment {
  return {
    id: s(r.id),
    observationId: s(r.observation_id),
    scorer: s(r.scorer),
    eventType: s(r.event_type),
    consequence: Number(r.consequence),
    urgency: Number(r.urgency),
    matches: parse(r.matches, []),
    rationale: s(r.rationale),
    ...(r.material === null || r.material === undefined ? {} : { material: Number(r.material) === 1 }),
    ...(r.held ? { held: s(r.held) as HeldReason } : {}),
    createdAt: s(r.created_at),
  };
}

function toAlert(r: Row): Alert {
  return {
    id: s(r.id),
    observationId: s(r.observation_id),
    judgmentId: s(r.judgment_id),
    eventId: sOrNull(r.event_id),
    reason: s(r.reason) as AlertReason,
    score: Number(r.score),
    targetKey: sOrNull(r.target_key),
    delivered: Number(r.delivered) === 1,
    deliveryError: sOrNull(r.delivery_error),
    createdAt: s(r.created_at),
  };
}

export type NewTheme = Pick<Theme, "name" | "description" | "keywords"> & { preset?: boolean };
export type NewPillar = Pick<Pillar, "statement"> & { signals: Omit<Signal, "id">[] };
export type NewTrade = Pick<Trade, "name" | "thesis" | "keywords" | "tickers" | "strengthens" | "weakens"> & {
  entities?: TradeEntity[];
  pillars?: NewPillar[];
  preset?: boolean;
};
export type NewEvent = Omit<MimirEvent, "id" | "lastSeenAt">;

/** An open event as offered to the model when it decides whether an item is new. */
export interface EventSummary extends MimirEvent {
  /** A few of its headlines, earliest first. */
  items: string[];
  impacts?: Impact[];
}

/** A pillar's recent evidence, so the model can judge cumulative weight. */
export interface PillarEvidence {
  eventId: string;
  tradeId: string;
  pillarId: string | null;
  effect: Effect;
  eventTitle: string;
  rationale: string;
  createdAt: string;
}
export type NewEntity = Pick<Entity, "name" | "kind" | "aliases">;
export type NewSource = Pick<Source, "type" | "name" | "config"> &
  Partial<Pick<Source, "enabled" | "weight" | "pollIntervalSeconds">>;
export type NewObservation = Omit<Observation, "id" | "fetchedAt"> & { raw?: unknown };

/** A judgment with the context the daily digest needs. */
export interface DigestRow {
  judgment: Judgment;
  title: string;
  url: string | null;
  publishedAt: string | null;
  sourceName: string;
  alerted: boolean;
}

export class Store {
  constructor(readonly client: Client) {}

  async migrate(): Promise<void> {
    await this.client.execute("PRAGMA foreign_keys = ON");
    for (const sql of MIGRATIONS) await this.client.execute(sql);
    const judgmentCols = await this.all("PRAGMA table_info(judgments)");
    if (!judgmentCols.some((c) => c.name === "material")) {
      await this.client.execute("ALTER TABLE judgments ADD COLUMN material INTEGER");
    }
    if (!judgmentCols.some((c) => c.name === "held")) {
      await this.client.execute("ALTER TABLE judgments ADD COLUMN held TEXT");
    }
    if (!(await this.all("PRAGMA table_info(trades)")).some((c) => c.name === "entities")) {
      await this.client.execute("ALTER TABLE trades ADD COLUMN entities TEXT NOT NULL DEFAULT '[]'");
    }
    if (!(await this.all("PRAGMA table_info(alerts)")).some((c) => c.name === "event_id")) {
      await this.client.execute("ALTER TABLE alerts ADD COLUMN event_id TEXT");
    }
  }

  private async all(sql: string, args: InValue[] = []): Promise<Row[]> {
    return (await this.client.execute({ sql, args })).rows;
  }

  private async run(sql: string, args: InValue[] = []): Promise<number> {
    return (await this.client.execute({ sql, args })).rowsAffected;
  }

  // Themes
  async listThemes(): Promise<Theme[]> {
    return (await this.all("SELECT * FROM themes ORDER BY created_at")).map(toTheme);
  }

  async createTheme(t: NewTheme): Promise<Theme> {
    const theme: Theme = { id: newId(), preset: false, createdAt: nowIso(), ...t };
    await this.run(
      "INSERT INTO themes (id, name, description, keywords, preset, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [theme.id, theme.name, theme.description, json(theme.keywords), theme.preset ? 1 : 0, theme.createdAt],
    );
    return theme;
  }

  async deleteTheme(id: string): Promise<boolean> {
    return (await this.run("DELETE FROM themes WHERE id = ?", [id])) > 0;
  }

  // Trades
  /** Trades with their pillars (retired ones included, flagged inactive). */
  async listTrades(): Promise<Trade[]> {
    const trades = (await this.all("SELECT * FROM trades ORDER BY created_at")).map(toTrade);
    const byTrade = new Map(trades.map((t) => [t.id, t]));
    for (const p of (await this.all("SELECT * FROM pillars ORDER BY created_at, rowid")).map(toPillar)) byTrade.get(p.tradeId)?.pillars.push(p);
    return trades;
  }

  async createTrade(t: NewTrade): Promise<Trade> {
    const { pillars = [], entities = [], ...rest } = t;
    const trade: Trade = { id: newId(), preset: false, createdAt: nowIso(), ...rest, entities, pillars: [] };
    await this.run(
      `INSERT INTO trades (id, name, thesis, keywords, tickers, strengthens, weakens, entities, preset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trade.id,
        trade.name,
        trade.thesis,
        json(trade.keywords),
        json(trade.tickers),
        json(trade.strengthens),
        json(trade.weakens),
        json(trade.entities),
        trade.preset ? 1 : 0,
        trade.createdAt,
      ],
    );
    for (const p of pillars) trade.pillars.push(await this.addPillar(trade.id, p));
    return trade;
  }

  async setTradeEntities(id: string, entities: TradeEntity[]): Promise<void> {
    await this.run("UPDATE trades SET entities = ? WHERE id = ?", [json(entities), id]);
  }

  async addPillar(tradeId: string, p: NewPillar): Promise<Pillar> {
    const pillar: Pillar = {
      id: newId(),
      tradeId,
      statement: p.statement,
      signals: p.signals.map((sig, i) => ({ id: String(i + 1), ...sig })),
      active: true,
      createdAt: nowIso(),
    };
    await this.run("INSERT INTO pillars (id, trade_id, statement, signals, active, created_at) VALUES (?, ?, ?, ?, 1, ?)", [
      pillar.id,
      tradeId,
      pillar.statement,
      json(pillar.signals),
      pillar.createdAt,
    ]);
    return pillar;
  }

  /** Retire a pillar: it stops being scored, but past impacts keep pointing at it. */
  async setPillarActive(id: string, active: boolean): Promise<boolean> {
    return (await this.run("UPDATE pillars SET active = ? WHERE id = ?", [active ? 1 : 0, id])) > 0;
  }

  async deleteTrade(id: string): Promise<boolean> {
    return (await this.run("DELETE FROM trades WHERE id = ?", [id])) > 0;
  }

  // Entities
  async listEntities(): Promise<Entity[]> {
    return (await this.all("SELECT * FROM entities ORDER BY created_at")).map(toEntity);
  }

  async createEntity(e: NewEntity): Promise<Entity> {
    const entity: Entity = { id: newId(), createdAt: nowIso(), ...e };
    await this.run("INSERT INTO entities (id, name, kind, aliases, created_at) VALUES (?, ?, ?, ?, ?)", [
      entity.id,
      entity.name,
      entity.kind,
      json(entity.aliases),
      entity.createdAt,
    ]);
    return entity;
  }

  async deleteEntity(id: string): Promise<boolean> {
    return (await this.run("DELETE FROM entities WHERE id = ?", [id])) > 0;
  }

  // Sources
  async listSources(): Promise<Source[]> {
    return (await this.all("SELECT * FROM sources ORDER BY created_at")).map(toSource);
  }

  async getSource(id: string): Promise<Source | undefined> {
    const [row] = await this.all("SELECT * FROM sources WHERE id = ?", [id]);
    return row ? toSource(row) : undefined;
  }

  async findSourceByName(name: string): Promise<Source | undefined> {
    const [row] = await this.all("SELECT * FROM sources WHERE name = ?", [name]);
    return row ? toSource(row) : undefined;
  }

  async createSource(src: NewSource): Promise<Source> {
    const source: Source = {
      id: newId(),
      enabled: true,
      weight: 1,
      pollIntervalSeconds: null,
      lastRunAt: null,
      lastError: null,
      createdAt: nowIso(),
      ...src,
    };
    await this.run(
      `INSERT INTO sources (id, type, name, config, enabled, weight, poll_interval_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.id,
        source.type,
        source.name,
        json(source.config),
        source.enabled ? 1 : 0,
        source.weight,
        source.pollIntervalSeconds,
        source.createdAt,
      ],
    );
    return source;
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<boolean> {
    return (await this.run("UPDATE sources SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id])) > 0;
  }

  async deleteSource(id: string): Promise<boolean> {
    return (await this.run("DELETE FROM sources WHERE id = ?", [id])) > 0;
  }

  async recordSourceRun(id: string, error: string | null): Promise<void> {
    await this.run("UPDATE sources SET last_run_at = ?, last_error = ? WHERE id = ?", [nowIso(), error, id]);
  }

  // Observations
  /**
   * Returns true if this source item or URL was already seen, or (when
   * `titleSince` is set) the same title fingerprint was fetched since then.
   */
  async isDuplicate(
    o: Pick<Observation, "sourceId" | "externalId" | "urlHash" | "titleHash">,
    titleSince: string | null,
  ): Promise<boolean> {
    const rows = await this.all(
      `SELECT 1 FROM observations
       WHERE (source_id = ? AND external_id = ?)
          OR (url_hash IS NOT NULL AND url_hash = ?)
          OR (? IS NOT NULL AND title_hash = ? AND fetched_at > ?)
       LIMIT 1`,
      [o.sourceId, o.externalId, o.urlHash, titleSince, o.titleHash, titleSince],
    );
    return rows.length > 0;
  }

  async insertObservation(o: NewObservation, fetchedAt = nowIso()): Promise<Observation> {
    const obs: Observation = {
      id: newId(),
      fetchedAt,
      sourceId: o.sourceId,
      externalId: o.externalId,
      url: o.url,
      title: o.title,
      summary: o.summary,
      publishedAt: o.publishedAt,
      urlHash: o.urlHash,
      titleHash: o.titleHash,
    };
    await this.run(
      `INSERT INTO observations
       (id, source_id, external_id, url, title, summary, published_at, fetched_at, url_hash, title_hash, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        obs.id,
        obs.sourceId,
        obs.externalId,
        obs.url,
        obs.title,
        obs.summary,
        obs.publishedAt,
        obs.fetchedAt,
        obs.urlHash,
        obs.titleHash,
        o.raw === undefined ? null : json(o.raw),
      ],
    );
    return obs;
  }

  async listObservations(limit = 50): Promise<(Observation & { judgment: Judgment | null })[]> {
    const rows = await this.all(
      `SELECT o.*, j.id AS j_id FROM observations o
       LEFT JOIN judgments j ON j.observation_id = o.id
       ORDER BY o.fetched_at DESC LIMIT ?`,
      [limit],
    );
    const judgments = await this.judgmentsByIds(rows.map((r) => r.j_id).filter((v) => v !== null) as InValue[]);
    return rows.map((r) => ({ ...toObservation(r), judgment: r.j_id ? (judgments.get(s(r.j_id)) ?? null) : null }));
  }

  async hasObservations(sourceId: string): Promise<boolean> {
    return (await this.all("SELECT 1 FROM observations WHERE source_id = ? LIMIT 1", [sourceId])).length > 0;
  }

  async getObservation(id: string): Promise<Observation | undefined> {
    const [row] = await this.all("SELECT * FROM observations WHERE id = ?", [id]);
    return row ? toObservation(row) : undefined;
  }

  // Judgments
  /** `signalAt` dates the per-target rows used for weak-signal accumulation (defaults to now). */
  async insertJudgment(j: Judgment, signalAt: string = j.createdAt): Promise<void> {
    await this.client.batch(
      [
        {
          sql: `INSERT INTO judgments (id, observation_id, scorer, event_type, consequence, urgency, matches, rationale, material, held, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            j.id,
            j.observationId,
            j.scorer,
            j.eventType,
            j.consequence,
            j.urgency,
            json(j.matches),
            j.rationale,
            j.material === undefined ? null : j.material ? 1 : 0,
            j.held ?? null,
            j.createdAt,
          ],
        },
        ...accumulatingMatches(j).map((m) => ({
          sql: "INSERT INTO judgment_targets (judgment_id, target_key, consequence, created_at) VALUES (?, ?, ?, ?)",
          args: [j.id, m.targetKey, j.consequence, signalAt],
        })),
      ],
      "write",
    );
  }

  async markHeld(judgmentId: string, reason: HeldReason): Promise<void> {
    await this.run("UPDATE judgments SET held = ? WHERE id = ?", [reason, judgmentId]);
  }

  private async judgmentsByIds(ids: InValue[]): Promise<Map<string, Judgment>> {
    if (ids.length === 0) return new Map();
    const rows = await this.all(`SELECT * FROM judgments WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return new Map(rows.map((r) => [s(r.id), toJudgment(r)]));
  }

  /**
   * Sum of weak-signal consequence for a target since `since`, excluding
   * signals already consumed by an earlier accumulated alert on that target.
   */
  async weakSignalSum(targetKey: string, since: string, floor: number, ceiling: number): Promise<number> {
    const [last] = await this.all(
      "SELECT MAX(created_at) AS t FROM alerts WHERE reason = 'accumulated' AND target_key = ?",
      [targetKey],
    );
    const lastAlert = last?.t ? s(last.t) : null;
    const from = lastAlert && lastAlert > since ? lastAlert : since;
    const [row] = await this.all(
      `SELECT COALESCE(SUM(consequence), 0) AS total FROM judgment_targets
       WHERE target_key = ? AND created_at > ? AND consequence >= ? AND consequence < ?`,
      [targetKey, from, floor, ceiling],
    );
    return Number(row?.total ?? 0);
  }

  // Events
  async createEvent(e: NewEvent): Promise<MimirEvent> {
    const event: MimirEvent = { id: newId(), ...e, lastSeenAt: e.firstSeenAt };
    await this.run("INSERT INTO events (id, title, type, entities, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)", [
      event.id,
      event.title,
      event.type,
      json(event.entities),
      event.firstSeenAt,
      event.lastSeenAt,
    ]);
    return event;
  }

  /** Record that an observation reports on an event; `how` is the step that matched it. */
  async addEventSource(
    eventId: string,
    observationId: string,
    how: "new" | "similar" | "model",
    similarity: number | null,
    embedding: Float32Array | null,
    at: string,
  ): Promise<void> {
    await this.client.batch(
      [
        {
          sql: "INSERT INTO event_sources (event_id, observation_id, how, similarity, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          args: [eventId, observationId, how, similarity, embedding ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength) : null, at],
        },
        { sql: "UPDATE events SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?", args: [at, eventId] },
      ],
      "write",
    );
  }

  /** Embeddings of observations attached to events since `since`, for similarity search. */
  async eventVectorsSince(since: string): Promise<{ eventId: string; vector: Float32Array; at: string }[]> {
    const rows = await this.all("SELECT event_id, embedding, created_at FROM event_sources WHERE embedding IS NOT NULL AND created_at > ?", [since]);
    return rows.map((r) => {
      const buf = r.embedding as ArrayBuffer;
      return { eventId: s(r.event_id), vector: new Float32Array(buf.slice(0)), at: s(r.created_at) };
    });
  }

  async eventSummaries(ids: string[]): Promise<EventSummary[]> {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const events = (await this.all(`SELECT * FROM events WHERE id IN (${marks})`, ids)).map(toEvent);
    const titles = await this.all(
      `SELECT es.event_id, o.title FROM event_sources es JOIN observations o ON o.id = es.observation_id
       WHERE es.event_id IN (${marks}) ORDER BY es.created_at, es.rowid`,
      ids,
    );
    const impacts = (await this.all(`SELECT * FROM impacts WHERE event_id IN (${marks}) ORDER BY created_at`, ids)).map(toImpact);
    return ids.flatMap((id) => {
      const e = events.find((x) => x.id === id);
      return e ? [{ ...e, items: titles.filter((t) => s(t.event_id) === id).slice(0, 3).map((t) => s(t.title)), impacts: impacts.filter((i) => i.eventId === id) }] : [];
    });
  }

  async eventIdForObservation(observationId: string): Promise<string | null> {
    const [row] = await this.all("SELECT event_id FROM event_sources WHERE observation_id = ? LIMIT 1", [observationId]);
    return row ? s(row.event_id) : null;
  }

  /** Events that produced an alert since `since`, newest first. */
  async alertedEventIdsSince(since: string): Promise<string[]> {
    const rows = await this.all(
      "SELECT event_id, MAX(created_at) AS t FROM alerts WHERE event_id IS NOT NULL AND created_at > ? GROUP BY event_id ORDER BY t DESC",
      [since],
    );
    return rows.map((r) => s(r.event_id));
  }

  async unlinkedAlertObservations(since: string): Promise<Observation[]> {
    return (await this.all(
      `SELECT o.* FROM observations o JOIN alerts a ON a.observation_id = o.id
       WHERE a.event_id IS NULL AND a.created_at > ? GROUP BY o.id ORDER BY MIN(a.created_at), o.rowid`,
      [since],
    )).map(toObservation);
  }

  async linkAlertsToEvent(observationId: string, eventId: string): Promise<void> {
    await this.run("UPDATE alerts SET event_id = ? WHERE observation_id = ? AND event_id IS NULL", [eventId, observationId]);
  }

  async eventImpacts(eventId: string): Promise<Impact[]> {
    return (await this.all("SELECT * FROM impacts WHERE event_id = ? ORDER BY created_at", [eventId])).map(toImpact);
  }

  async insertImpact(i: Omit<Impact, "id">): Promise<Impact> {
    const impact: Impact = { id: newId(), ...i };
    await this.run(
      `INSERT INTO impacts (id, event_id, observation_id, trade_id, pillar_id, effect, signal_id, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [impact.id, impact.eventId, impact.observationId, impact.tradeId, impact.pillarId, impact.effect, impact.signalId, impact.rationale, impact.createdAt],
    );
    return impact;
  }

  /** One reading per event and pillar, newest first; an upgrade isn't a second piece of evidence. */
  async impactsSince(since: string): Promise<PillarEvidence[]> {
    const rows = await this.all(
      `WITH readings AS (
         SELECT i.*, ROW_NUMBER() OVER (PARTITION BY event_id, trade_id, pillar_id ORDER BY created_at DESC, rowid DESC) AS latest
         FROM impacts i WHERE i.created_at > ?
       )
       SELECT i.*, e.title FROM readings i JOIN events e ON e.id = i.event_id
       WHERE i.latest = 1 ORDER BY i.created_at DESC`,
      [since],
    );
    return rows.map((r) => ({
      eventId: s(r.event_id),
      tradeId: s(r.trade_id),
      pillarId: sOrNull(r.pillar_id),
      effect: s(r.effect) as Effect,
      eventTitle: s(r.title),
      rationale: s(r.rationale),
      createdAt: s(r.created_at),
    }));
  }

  // Alerts
  async insertAlert(a: Omit<Alert, "id" | "createdAt">, createdAt = nowIso()): Promise<Alert> {
    const alert: Alert = { id: newId(), createdAt, ...a };
    await this.run(
      `INSERT INTO alerts (id, observation_id, judgment_id, event_id, reason, score, target_key, delivered, delivery_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        alert.id,
        alert.observationId,
        alert.judgmentId,
        alert.eventId ?? null,
        alert.reason,
        alert.score,
        alert.targetKey,
        alert.delivered ? 1 : 0,
        alert.deliveryError,
        alert.createdAt,
      ],
    );
    return alert;
  }

  /** Alerts created after `since`, oldest first, with headline and judgment. */
  async alertsSince(since: string): Promise<{ createdAt: string; title: string; judgment: Judgment }[]> {
    const rows = await this.all(
      `SELECT a.created_at AS alert_at, o.title AS o_title, j.* FROM alerts a
       JOIN judgments j ON j.id = a.judgment_id
       JOIN observations o ON o.id = a.observation_id
       WHERE a.created_at > ?
       ORDER BY a.created_at`,
      [since],
    );
    return rows.map((r) => ({ createdAt: s(r.alert_at), title: s(r.o_title), judgment: toJudgment(r) }));
  }

  async firstObservationAt(): Promise<string | null> {
    const [row] = await this.all("SELECT MIN(fetched_at) AS t FROM observations");
    return row?.t ? s(row.t) : null;
  }

  /** Replay only: drop every observation, judgment and alert, keeping sources and watchlists. */
  async resetEvents(): Promise<void> {
    for (const table of ["alerts", "impacts", "event_sources", "events", "judgment_targets", "judgments", "observations", "meta"]) await this.run(`DELETE FROM ${table}`);
  }

  async recentAlertTitles(since: string): Promise<string[]> {
    const rows = await this.all(
      `SELECT o.title FROM alerts a JOIN observations o ON o.id = a.observation_id WHERE a.created_at > ?`,
      [since],
    );
    return rows.map((r) => s(r.title));
  }

  async lastAlertAt(targetKey: string): Promise<string | null> {
    const [row] = await this.all("SELECT MAX(created_at) AS t FROM alerts WHERE target_key = ?", [targetKey]);
    return row?.t ? s(row.t) : null;
  }

  async markAlertDelivery(id: string, error: string | null): Promise<void> {
    await this.run("UPDATE alerts SET delivered = ?, delivery_error = ? WHERE id = ?", [error ? 0 : 1, error, id]);
  }

  /** Judgments created after `since`, highest consequence first, flagged if they produced an alert. */
  async digestRows(since: string): Promise<DigestRow[]> {
    const rows = await this.all(
      `SELECT j.*, o.title AS o_title, o.url AS o_url, o.published_at AS o_published_at, s.name AS s_name,
              EXISTS (SELECT 1 FROM alerts a WHERE a.judgment_id = j.id) AS alerted
       FROM judgments j
       JOIN observations o ON o.id = j.observation_id
       JOIN sources s ON s.id = o.source_id
       WHERE j.created_at > ?
       ORDER BY j.consequence DESC`,
      [since],
    );
    return rows.map((r) => ({
      judgment: toJudgment(r),
      title: s(r.o_title),
      url: sOrNull(r.o_url),
      publishedAt: sOrNull(r.o_published_at),
      sourceName: s(r.s_name),
      alerted: Number(r.alerted) === 1,
    }));
  }

  // Meta (small key/value state, e.g. when the digest last went out)
  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.all("SELECT value FROM meta WHERE key = ?", [key]);
    return row ? s(row.value) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  async listAlerts(limit = 50): Promise<(Alert & { observation: Observation; judgment: Judgment })[]> {
    const rows = await this.all("SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?", [limit]);
    const alerts = rows.map(toAlert);
    const judgments = await this.judgmentsByIds(alerts.map((a) => a.judgmentId));
    const out = [];
    for (const a of alerts) {
      const observation = await this.getObservation(a.observationId);
      const judgment = judgments.get(a.judgmentId);
      if (observation && judgment) out.push({ ...a, observation, judgment });
    }
    return out;
  }
}

export async function openStore(url: string, authToken?: string): Promise<Store> {
  const store = new Store(createClient({ url, authToken }));
  await store.migrate();
  return store;
}
