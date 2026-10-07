// Replay stored history (a copy of the production DB) through the current pipeline, then check pushes against market moves.
//   npm run replay -- --db ./mimir-copy.db [--bars 0.45,0.5,0.55] [--rescore | --rescore-all] [--json out.json] [--no-market]
//                     [--events] [--mode legacy|events]
// --events groups items into events (local embeddings + the model's same-event call); --mode events also pushes on
// new major pillar impacts instead of material verdicts. Both need fresh verdicts, so they imply --rescore-all.
// Saved model verdicts are reused by default (free, deterministic). --rescore re-asks the model for items it called
// material or scored 0.3+ (to test a prompt change); --rescore-all for every item. Fresh verdicts are cached by title.
// The input file is never modified, and nothing is delivered anywhere.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { directionLine } from "../src/alerts.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { closestOnTrade, localParts, medianLatency, nearMissReason, pillarGaps } from "../src/digest.js";
import { createLocalEmbedder, EventIndex } from "../src/events.js";
import { checkMarket, loadPrices, summarizeMarket, type MarketCheck, type Prices } from "../src/market.js";
import { historyScorer, isCandidate, loadHistory, replayHistory, type CachedVerdict, type ReplayResult } from "../src/replay.js";
import { addPresetPillars } from "../src/presets.js";
import { createLlmScorer } from "../src/scoring/llm.js";

const COST_PER_CALL = 0.0008;
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const dbPath = flag("db");
if (!dbPath || !existsSync(dbPath)) throw new Error("--db <path to a copy of mimir.db> is required");
const config = loadConfig();
const tz = config.digestTimeZone;
const current = config.materialMinScore;
const bars = [...new Set([...(flag("bars")?.split(",").map(Number) ?? []), current])].sort((a, b) => a - b);
if (bars.some((b) => !Number.isFinite(b))) throw new Error("--bars must be numbers, e.g. 0.45,0.5,0.55");

const mode = flag("mode") ?? "legacy";
if (mode !== "legacy" && mode !== "events") throw new Error("--mode must be legacy or events");
const grouping = has("events") || mode === "events";

const dir = mkdtempSync(join(tmpdir(), "mimir-replay-"));
const work = join(dir, "replay.db");
copyFileSync(dbPath, work);
for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, work + ext);
const client = createClient({ url: `file:${work}` });

try {
  const store = new Store(client);
  await store.migrate();
  // What the server's startup seeding would add on deploy.
  await addPresetPillars(store);
  const rows = await loadHistory(client);
  if (rows.length === 0) throw new Error("no observations in the database");

  const all = has("rescore-all") || grouping;
  const rescore = all || has("rescore");
  // Grouped verdicts carry event and pillar calls the plain ones lack, so they get their own cache.
  const cachePath = flag("cache") ?? (grouping ? ".replay-cache-events.json" : ".replay-cache.json");
  const cache = new Map<string, CachedVerdict>(
    rescore && existsSync(cachePath) ? Object.entries(JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, CachedVerdict>) : [],
  );
  const events = grouping ? new EventIndex(createLocalEmbedder()) : undefined;
  let model;
  if (rescore) {
    if (!config.llm) throw new Error("--rescore needs LLM_API_KEY");
    model = createLlmScorer(config.llm);
    const todo = rows.filter((r) => !r.baseline && (all || isCandidate(r.verdict)) && !cache.has(r.title)).length;
    console.error(`Re-asking ${config.llm.model} about up to ${todo} items (~$${(todo * COST_PER_CALL).toFixed(2)})`);
  }

  const results: { bar: number; result: ReplayResult; calls: number }[] = [];
  for (const bar of bars) {
    const scorer = historyScorer(rows, { model, all, cache });
    const result = await replayHistory(store, rows, { scorer, policy: { ...config, materialMinScore: bar, alertMode: mode }, events });
    results.push({ bar, result, calls: scorer.modelCalls() });
    if (rescore) writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
  }

  const trades = await store.listTrades();
  const first = results[0]!.result;
  let prices: Prices | undefined;
  if (!has("no-market")) prices = await loadPrices(trades, new Date(first.from), new Date());
  const markets = new Map<number, MarketCheck>();
  if (prices) for (const { bar, result } of results) markets.set(bar, checkMarket(trades, prices, result.pushes, new Date(result.from), new Date(result.to)));

  const when = (iso: string): string => {
    const p = localParts(new Date(iso), tz);
    return `${p.date} ${p.time}`;
  };
  const out: string[] = [];
  out.push(
    `Replay of ${dbPath}: ${first.items} items fetched ${when(first.from)} to ${when(first.to)} ${tz} (${first.days} days)`,
    `Alert mode: ${mode}${grouping ? ", event grouping on" : ""}`,
    rescore ? `Verdicts: re-asked the model (${results.reduce((n, r) => n + r.calls, 0)} calls, rest from cache/saved)` : "Verdicts: saved from production (no model calls)",
  );
  if (first.days < 7) out.push(`Only ${first.days} days of history: treat these numbers as a smoke test, not a verdict.`);
  out.push("", "bar     pushes  per day  big days caught  quiet-day pushes  held cooldown/same story/same event");
  for (const { bar, result } of results) {
    const m = markets.get(bar);
    const s = m ? summarizeMarket(m) : undefined;
    out.push(
      [
        `${bar.toFixed(2)}${bar === current ? "*" : " "}`.padEnd(8),
        String(result.pushes.length).padEnd(8),
        (result.pushes.length / result.days).toFixed(1).padEnd(9),
        (s ? `${s.caught}/${s.bigDays}` : "n/a").padEnd(17),
        (s ? `${s.quietPushes}/${s.labelledPushes}` : "n/a").padEnd(18),
        `${result.held.cooldown ?? 0}/${result.held.same_story ?? 0}/${result.held.same_event ?? 0}`,
      ].join(""),
    );
  }
  out.push("* current MATERIAL_MIN_SCORE");

  const cur = results.find((r) => r.bar === current)!.result;
  const market = markets.get(current);
  out.push(
    "",
    `At the current bar: ${cur.alerts} alerts, ${cur.pushes.length} pushes · verdicts ${cur.verdicts.material} material / ${cur.verdicts.notMaterial} not / ${cur.verdicts.noModel} no model · held ${JSON.stringify(cur.held)}`,
    "",
    "PUSHES",
  );
  for (const p of cur.pushes) {
    const late = p.lateMinutes === null ? "" : `  (+${p.lateMinutes}m after publish)`;
    out.push(`• ${when(p.at)}  ${p.consequence.toFixed(2)}  ${directionLine(p.matches)}  ${p.title}${late}`);
  }
  const lag = medianLatency(cur.judged);
  if (lag) out.push(`Latency published → push: median ${lag.minutes}m over ${lag.n}`);
  if (market) {
    out.push("", "BIG MOVE DAYS (basket move ≥ 2.5× its 60-session median)");
    const big = market.days.filter((d) => d.big);
    if (big.length === 0) out.push("• none in range");
    for (const d of big) {
      const tag = `${d.date} ${d.tradeName} ${(d.ratio ?? 0).toFixed(1)}×`;
      if (d.caught.length > 0) out.push(`• ${tag} — caught: ${d.caught.map((p) => p.title).join(" | ")}`);
      else {
        const c = closestOnTrade(cur.judged, d);
        out.push(`• ${tag} — missed${c ? ` · closest ${c.judgment.consequence.toFixed(2)} ${c.title} [${nearMissReason(c)}]` : " · nothing matched"}`);
      }
    }
    if (market.missing.length > 0) out.push(`No prices: ${market.missing.join(", ")}`);
  }
  out.push("", "NEAR-MISSES");
  for (const r of cur.nearMisses) out.push(`• ${r.judgment.consequence.toFixed(2)} ${r.title} [${nearMissReason(r)}]`);
  if (grouping) out.push(...(await eventLines(store, client, trades, results.length > 1)));
  console.log(out.join("\n"));

  const jsonPath = flag("json");
  if (jsonPath) {
    const summary = results.map(({ bar, result, calls }) => {
      const m = markets.get(bar);
      return {
        bar,
        calls,
        from: result.from,
        to: result.to,
        days: result.days,
        items: result.items,
        skipped: result.skipped,
        alerts: result.alerts,
        held: result.held,
        verdicts: result.verdicts,
        pushes: result.pushes,
        nearMisses: result.nearMisses.map((r) => ({ title: r.title, consequence: r.judgment.consequence, reason: nearMissReason(r) })),
        market: m ? { summary: summarizeMarket(m), bigDays: m.days.filter((d) => d.big), missing: m.missing } : null,
      };
    });
    writeFileSync(jsonPath, JSON.stringify({ db: dbPath, currentBar: current, results: summary }, null, 2));
  }
} finally {
  client.close();
  rmSync(dir, { recursive: true, force: true });
}

/** How items grouped into events and how events moved pillars, from the last run. */
async function eventLines(store: Store, db: typeof client, trades: Awaited<ReturnType<Store["listTrades"]>>, lastOfSeveral: boolean): Promise<string[]> {
  const n = async (sql: string) => Number((await db.execute(sql)).rows[0]?.n ?? 0);
  const lines = ["", `EVENTS${lastOfSeveral ? " (last run)" : ""}`];
  const items = await n("SELECT COUNT(*) AS n FROM event_sources");
  const total = await n("SELECT COUNT(*) AS n FROM events");
  const multi = await n("SELECT COUNT(*) AS n FROM (SELECT event_id FROM event_sources GROUP BY event_id HAVING COUNT(*) > 1)");
  const how = (await db.execute("SELECT how, COUNT(*) AS n FROM event_sources GROUP BY how")).rows.map((r) => `${r.how} ${r.n}`).join(", ");
  lines.push(`${items} items → ${total} events · ${multi} with 2+ reports · matched by: ${how}`);
  const top = await db.execute(
    `SELECT e.title, COUNT(*) AS n FROM event_sources es JOIN events e ON e.id = es.event_id GROUP BY e.id HAVING n > 2 ORDER BY n DESC LIMIT 15`,
  );
  for (const r of top.rows) lines.push(`• ${r.n}× ${r.title}`);
  const pillarName = new Map(trades.flatMap((t) => t.pillars.map((p) => [p.id, `${t.name}: ${p.statement}`] as const)));
  const impacts = await db.execute(
    "SELECT pillar_id, trade_id, effect, COUNT(*) AS n FROM impacts GROUP BY pillar_id, trade_id, effect ORDER BY pillar_id, effect",
  );
  const byPillar = new Map<string, string[]>();
  for (const r of impacts.rows) {
    const name = r.pillar_id ? (pillarName.get(String(r.pillar_id)) ?? String(r.pillar_id)) : `${trades.find((t) => t.id === r.trade_id)?.name}: (fits no pillar)`;
    byPillar.set(name, [...(byPillar.get(name) ?? []), `${r.effect} ${r.n}`]);
  }
  lines.push("", "PILLAR IMPACTS");
  for (const [name, counts] of [...byPillar].sort()) lines.push(`• ${name} — ${counts.join(", ")}`);
  const gaps = await pillarGaps(store, new Date(0).toISOString());
  if (gaps.length > 0) {
    lines.push("", "FITS NO PILLAR");
    for (const g of gaps) lines.push(`• ${g.trade}: ${g.events.slice(0, 5).join(" | ")}`);
  }
  return lines;
}
