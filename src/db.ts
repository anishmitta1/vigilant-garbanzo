import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import { accumulatingMatches } from "./alerts.js";
import type {
  Alert,
  AlertReason,
  Entity,
  EntityKind,
  Judgment,
  Observation,
  Source,
  Theme,
  Trade,
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
    strengthens: parse<string[]>(r.strengthens, []),
    weakens: parse<string[]>(r.weakens, []),
    preset: Number(r.preset) === 1,
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
    createdAt: s(r.created_at),
  };
}

function toAlert(r: Row): Alert {
  return {
    id: s(r.id),
    observationId: s(r.observation_id),
    judgmentId: s(r.judgment_id),
    reason: s(r.reason) as AlertReason,
    score: Number(r.score),
    targetKey: sOrNull(r.target_key),
    delivered: Number(r.delivered) === 1,
    deliveryError: sOrNull(r.delivery_error),
    createdAt: s(r.created_at),
  };
}

export type NewTheme = Pick<Theme, "name" | "description" | "keywords"> & { preset?: boolean };
export type NewTrade = Pick<Trade, "name" | "thesis" | "keywords" | "tickers" | "strengthens" | "weakens"> & {
  preset?: boolean;
};
export type NewEntity = Pick<Entity, "name" | "kind" | "aliases">;
export type NewSource = Pick<Source, "type" | "name" | "config"> &
  Partial<Pick<Source, "enabled" | "weight" | "pollIntervalSeconds">>;
export type NewObservation = Omit<Observation, "id" | "fetchedAt"> & { raw?: unknown };

export class Store {
  constructor(readonly client: Client) {}

  async migrate(): Promise<void> {
    await this.client.execute("PRAGMA foreign_keys = ON");
    for (const sql of MIGRATIONS) await this.client.execute(sql);
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
  async listTrades(): Promise<Trade[]> {
    return (await this.all("SELECT * FROM trades ORDER BY created_at")).map(toTrade);
  }

  async createTrade(t: NewTrade): Promise<Trade> {
    const trade: Trade = { id: newId(), preset: false, createdAt: nowIso(), ...t };
    await this.run(
      `INSERT INTO trades (id, name, thesis, keywords, tickers, strengthens, weakens, preset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trade.id,
        trade.name,
        trade.thesis,
        json(trade.keywords),
        json(trade.tickers),
        json(trade.strengthens),
        json(trade.weakens),
        trade.preset ? 1 : 0,
        trade.createdAt,
      ],
    );
    return trade;
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

  async insertObservation(o: NewObservation): Promise<Observation> {
    const obs: Observation = {
      id: newId(),
      fetchedAt: nowIso(),
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
          sql: `INSERT INTO judgments (id, observation_id, scorer, event_type, consequence, urgency, matches, rationale, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            j.id,
            j.observationId,
            j.scorer,
            j.eventType,
            j.consequence,
            j.urgency,
            json(j.matches),
            j.rationale,
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

  // Alerts
  async insertAlert(a: Omit<Alert, "id" | "createdAt">): Promise<Alert> {
    const alert: Alert = { id: newId(), createdAt: nowIso(), ...a };
    await this.run(
      `INSERT INTO alerts (id, observation_id, judgment_id, reason, score, target_key, delivered, delivery_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        alert.id,
        alert.observationId,
        alert.judgmentId,
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

  async lastAlertAt(targetKey: string): Promise<string | null> {
    const [row] = await this.all("SELECT MAX(created_at) AS t FROM alerts WHERE target_key = ?", [targetKey]);
    return row?.t ? s(row.t) : null;
  }

  async markAlertDelivery(id: string, error: string | null): Promise<void> {
    await this.run("UPDATE alerts SET delivered = ?, delivery_error = ? WHERE id = ?", [error ? 0 : 1, error, id]);
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
