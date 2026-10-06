// Free daily prices (Yahoo chart API) and per-trade "big move day" detection: an objective check on alerts
// that doesn't depend on hand-picked labels. A big day is a candidate catalyst, not proof one was missed.
import type { Trade } from "./types.js";

const ET = "America/New_York";
/** A basket had a big day when its average absolute move is at least this multiple of its typical day. */
export const BIG_MOVE_MULTIPLE = 2.5;
const BASELINE_DAYS = 60;
const MIN_BASELINE_DAYS = 20;
/** Calendar days of history fetched before a window, enough for the baseline. */
const BASELINE_LOOKBACK_DAYS = 100;
const SESSION_CLOSE = "16:00";

/** ET trading date -> close. */
export type Closes = Map<string, number>;

export interface Prices {
  closes: Map<string, Closes>;
  missing: string[];
}

export interface Push {
  at: string;
  title: string;
  tradeIds: string[];
}

export interface BasketDay {
  date: string;
  /** Average absolute daily return across the basket's priced tickers. */
  move: number;
  /** Median `move` over the previous 60 sessions (null until 20 are available). */
  baseline: number | null;
  ratio: number | null;
  tickers: number;
}

export interface TradeDay extends BasketDay {
  prevDate: string;
  tradeId: string;
  tradeName: string;
  big: boolean;
  /** Pushes on this trade between the previous session's close and this session's close. */
  caught: Push[];
}

export interface PushOutcome {
  push: Push;
  tradeId: string;
  /** Session the push could have called (null if that session hasn't closed or isn't in the data). */
  date: string | null;
  big: boolean | null;
}

export interface MarketCheck {
  days: TradeDay[];
  pushes: PushOutcome[];
  missing: string[];
}

/** ET calendar date ("YYYY-MM-DD") and time ("HH:MM"). */
export function etParts(at: Date): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ET,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

interface ChartResponse {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] };
    }[];
  };
}

/** Daily closes for `ticker` from `from` to `now`. Today's bar is dropped until the session has closed. */
export async function fetchCloses(ticker: string, from: Date, now: Date, fetchImpl: typeof fetch = fetch): Promise<Closes> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${Math.floor(from.getTime() / 1000)}&period2=${Math.floor(now.getTime() / 1000) + 86_400}&interval=1d`;
  const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (mimir)" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const result = ((await res.json()) as ChartResponse).chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const closes = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];
  const today = etParts(now);
  const out: Closes = new Map();
  stamps.forEach((t, i) => {
    const c = closes[i];
    const date = etParts(new Date(t * 1000)).date;
    if (date === today.date && today.time < "16:30") return;
    if (typeof c === "number" && Number.isFinite(c) && c > 0) out.set(date, c);
  });
  return out;
}

/** Closes for every ticker across `trades`, from far enough before `from` to build baselines. Failures are listed, not fatal. */
export async function loadPrices(trades: Trade[], from: Date, now: Date, fetchImpl: typeof fetch = fetch): Promise<Prices> {
  const tickers = [...new Set(trades.flatMap((t) => t.tickers))].sort();
  const start = new Date(from.getTime() - BASELINE_LOOKBACK_DAYS * 86_400_000);
  const closes = new Map<string, Closes>();
  const missing: string[] = [];
  for (let i = 0; i < tickers.length; i += 6) {
    const batch = tickers.slice(i, i + 6);
    const results = await Promise.allSettled(batch.map((t) => fetchCloses(t, start, now, fetchImpl)));
    results.forEach((r, j) => {
      if (r.status === "fulfilled" && r.value.size > 0) closes.set(batch[j]!, r.value);
      else missing.push(batch[j]!);
    });
  }
  return { closes, missing };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Direction-agnostic: baskets mix longs and inverses (TLT/TBT), so absolute moves are averaged. */
export function basketDays(series: Closes[]): BasketDay[] {
  const dates = [...new Set(series.flatMap((s) => [...s.keys()]))].sort();
  const moves: { date: string; move: number; tickers: number }[] = [];
  for (let i = 1; i < dates.length; i++) {
    const rets: number[] = [];
    for (const s of series) {
      const a = s.get(dates[i - 1]!);
      const b = s.get(dates[i]!);
      if (a && b) rets.push(Math.abs(b / a - 1));
    }
    if (rets.length > 0) moves.push({ date: dates[i]!, move: rets.reduce((x, y) => x + y, 0) / rets.length, tickers: rets.length });
  }
  return moves.map((m, i) => {
    const prior = moves.slice(Math.max(0, i - BASELINE_DAYS), i).map((p) => p.move);
    const baseline = prior.length >= MIN_BASELINE_DAYS ? median(prior) : null;
    return { ...m, baseline, ratio: baseline ? m.move / baseline : null };
  });
}

/** Whether `at` falls after `prevDate`'s close and at or before `date`'s close (ET). */
export function inSession(at: string, prevDate: string, date: string): boolean {
  const p = etParts(new Date(at));
  const afterPrev = p.date > prevDate || (p.date === prevDate && p.time >= SESSION_CLOSE);
  const beforeClose = p.date < date || (p.date === date && p.time < SESSION_CLOSE);
  return afterPrev && beforeClose;
}

const nextDate = (date: string): string => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Big-move days per trade in [from, to], whether a push on that trade preceded each, and how each push lined up. */
export function checkMarket(trades: Trade[], prices: Prices, pushes: Push[], from: Date, to: Date): MarketCheck {
  // A session counts only if it closed after `from` (Mimir was running for part of it).
  const start = etParts(from);
  const first = start.time < SESSION_CLOSE ? start.date : nextDate(start.date);
  const last = etParts(to).date;
  const days: TradeDay[] = [];
  const outcomes: PushOutcome[] = [];
  for (const trade of trades) {
    const series = trade.tickers.map((t) => prices.closes.get(t)).filter((c): c is Closes => c !== undefined);
    const all = basketDays(series);
    const onTrade = pushes.filter((p) => p.tradeIds.includes(trade.id));
    const placed = new Map<Push, TradeDay>();
    for (let i = 1; i < all.length; i++) {
      const d = all[i]!;
      const prev = all[i - 1]!.date;
      const caught = onTrade.filter((p) => inSession(p.at, prev, d.date));
      const day: TradeDay = { ...d, prevDate: prev, tradeId: trade.id, tradeName: trade.name, big: d.ratio !== null && d.ratio >= BIG_MOVE_MULTIPLE, caught };
      for (const p of caught) placed.set(p, day);
      if (d.date >= first && d.date <= last) days.push(day);
    }
    for (const push of onTrade) {
      const day = placed.get(push);
      outcomes.push({ push, tradeId: trade.id, date: day?.date ?? null, big: day ? day.big : null });
    }
  }
  return { days, pushes: outcomes, missing: prices.missing };
}

export interface MarketSummary {
  sessions: number;
  bigDays: number;
  caught: number;
  quietPushes: number;
  labelledPushes: number;
}

export function summarizeMarket(check: MarketCheck): MarketSummary {
  const big = check.days.filter((d) => d.big);
  const labelled = check.pushes.filter((p) => p.big !== null);
  return {
    sessions: new Set(check.days.map((d) => d.date)).size,
    bigDays: big.length,
    caught: big.filter((d) => d.caught.length > 0).length,
    quietPushes: labelled.filter((p) => p.big === false).length,
    labelledPushes: labelled.length,
  };
}
