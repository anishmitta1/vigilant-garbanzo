# Mimir

Consequential event intelligence for investors.

Mimir watches broad themes, entities, and custom investment theses, continuously filters incoming information, and surfaces only developments that may materially change what an investor cares about.

## Product

Users:
1. Pick preset themes (AI infrastructure, semiconductors, crypto, rates/liquidity, energy, etc.).
2. Add custom themes in natural language.
3. Add entities, tickers, projects, people, regulations, and portfolio exposures.
4. Receive low-noise alerts/webhooks when consequential developments occur.

The core question is not "is this relevant?" but:

> Does this materially change something the investor cares about?

## Architecture

```text
sources
  -> ingestion
  -> deterministic preprocessing
  -> system-1 judgments
  -> event/state store
  -> correlation + accumulation
  -> frontier-model reasoning when warranted
  -> alerts / webhooks / UI
```

### System 0
Deterministic code handles parsing, math, dates, deduplication, normalization, market data, and graph operations.

### System 1
Fast decision models (e.g. Jev-style models) make high-volume semantic judgments such as:
- new vs duplicate
- tracked entity/theme association
- event classification
- contradiction / state change
- consequence probability
- urgency
- escalation priority

### System 2
Frontier models are used sparingly for expensive reasoning, synthesis, and thesis-level interpretation.

## MVP

Build the smallest loop that proves value:

```text
source -> observation -> classify -> score consequence -> store -> alert
```

Start with a narrow set of sources and a few strong preset themes. Optimize for recall of consequential events and low alert noise before expanding coverage.

## Principles

- Consequential > merely relevant.
- Observe broadly; reason deeply only when warranted.
- Large relevant context is useful; large noisy context is harmful.
- Weak signals should accumulate instead of being discarded immediately.
- Avoid single hard gates that create catastrophic false negatives.
- Keep investor-specific context private and configurable.
- Prefer simple code and explicit decision functions over agentic complexity.

## Running

Requires Node 22+.

```bash
npm install
cp .env.example .env   # optional; every setting has a default
npm run dev            # tsx watch on :3000
npm test && npm run typecheck && npm run lint
npm run build && npm start
```

On start Mimir seeds the preset themes and trades (when their tables are empty) and adds any default source missing by name (disable a default source rather than deleting it), then polls every enabled source on its interval (`POLL_INTERVAL_SECONDS`, or per source).

### Storage (SQLite now, Turso later)

Storage uses [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts). Locally `DATABASE_URL=file:mimir.db` is a plain SQLite file. To move to Turso, set `DATABASE_URL=libsql://<db>-<org>.turso.io` and `TURSO_AUTH_TOKEN`; no code changes are needed.

### Code layout

```text
src/
  sources/        one adapter per source type + registry (System 0 ingestion)
  preprocess.ts   HTML stripping, URL canonicalization, title fingerprints (dedupe)
  scoring/        System 1: heuristic scorer (default) and optional LLM scorer
  alerts.ts       alert decision (direct + accumulated weak signals) and delivery (webhook, Slack, Bark, ntfy)
  presets.ts      preset themes, trades and default sources
  pipeline.ts     source -> observation -> classify -> score -> store -> alert
  db.ts           libSQL schema and queries
  server.ts       HTTP API
```

### Sources

| type | what it covers | config |
| --- | --- | --- |
| `rss` | Any RSS/Atom/RDF feed: news, Substack, blogs, Reddit `.rss`, YouTube channels, arXiv, GitHub `releases.atom`, central banks | `{ url }` |
| `google-news` | Google News search (supports `site:`, `when:7d`, `OR`) | `{ query, language?, country? }` |
| `sec-edgar` | SEC filings, market-wide or for one company | `{ forms?: ["8-K"], cik?, count? }` |
| `hackernews` | HN stories via Algolia | `{ query?, minPoints?, limit? }` |
| `reddit` | Subreddit listings | `{ subreddit, sort?, minScore?, limit? }` |
| `federal-register` | US rules, proposed rules, notices, presidential docs | `{ term?, agencies?, documentTypes? }` |
| `json` | Any JSON API with dotted-path field mapping | `{ url, itemsPath, fields: { id?, title, url?, summary?, publishedAt? } }` |
| `html` | Any HTML listing page via CSS selectors (press releases, regulators, IR pages) | `{ url, itemSelector, fields: { title?, link?, summary?, date?, dateAttribute? } }` |
| `push` | Anything that can POST to `/ingest` (scripts, other scrapers, Zapier) | `{}` |

To add a source type, add a file in `src/sources/` exporting `defineAdapter({ type, description, configSchema, fetch })` and register it in `registry.ts`.

SEC requires a descriptive `USER_AGENT` with contact info. Reddit blocks its JSON API from many datacenter IPs; the `reddit` adapter then falls back to the subreddit's RSS feed (no scores, so `minScore` is ignored).

### Trades

Trades are popular narratives tracked as first-class targets (`trade:<id>`), alongside themes and entities. Each has a `thesis`, `keywords` and `tickers` that make an item relevant, and `strengthens` / `weakens` phrases that say which way a relevant item pushes the thesis. Alerts show the direction, e.g. `AI infra buildout ↑ strengthening`. Presets (`src/presets.ts`): AI infra buildout, Crypto clarity, Yield curve unwinding, Power & nuclear demand, Tariffs & reshoring, Gold & de-dollarization, each backed by primary sources (SEC, CFTC, White House, Commerce BIS, NRC, EIA) and a targeted Google News query.

### Scoring and alerts

- Heuristic scorer: matches tracked trades, entities (tickers are case-sensitive) and theme keywords, classifies the event type from an explicit lexicon, and computes `consequence = relevance x event weight x source weight`. A trade thesis signal on a relevant item counts as an event of weight at least 0.7.
- The LLM scorer also gets each trade's thesis and signals and returns a direction per trade.
- Optional LLM scorer: set `LLM_API_KEY` (any OpenAI-compatible API, see `LLM_BASE_URL` and `LLM_MODEL`). If the call fails, scoring falls back to the heuristic.
- Alerts: `consequence >= ALERT_THRESHOLD` alerts directly. Weak signals (`>= WEAK_SIGNAL_FLOOR`) accumulate per target over `ACCUMULATION_WINDOW_HOURS`, and an alert fires once a target's total reaches `ACCUMULATION_THRESHOLD`. Items published more than `MAX_ALERT_AGE_HOURS` (default 48) ago are stored and scored but never alert or accumulate, so a new source's backlog doesn't page you. A source's first poll is a silent baseline (stored and scored, no alerts). After an alert on a target, further alerts on it are held for `ALERT_COOLDOWN_HOURS` (default 6) unless a direct alert scores at least `COOLDOWN_BYPASS_SCORE` (default 0.9). An alert whose headline matches a story already alerted on within `STORY_WINDOW_HOURS` (default 48), from any outlet, is skipped. Bark is the "drop everything" channel: it only receives direct alerts scoring at least `BARK_MIN_SCORE` (default 0.8). Alerts are stored and delivered to every configured channel:
  - **iPhone push (Bark):** install [Bark](https://apps.apple.com/app/id1403753865) and set `BARK_URL` to the device URL it shows (`https://api.day.app/<key>`). Treat it as a secret (anyone with it can push to your phone). Strong direct alerts (>= 0.85) are time-sensitive, so they break through Focus; tapping opens the article. Bark talks to Apple's push service directly, so it is more reliable on iPhone than ntfy.
  - **Phone push (ntfy):** install the [ntfy](https://ntfy.sh) app, subscribe to a long random topic, and set `NTFY_TOPIC` to it. No account needed; anyone who knows the topic can read it, so keep it unguessable (or use `NTFY_TOKEN` with a protected topic / self-hosted `NTFY_URL`). Strong direct alerts (score >= 0.85) are sent as urgent (priority 5), other direct alerts as high, accumulated as default; tapping opens the article.
  - **Slack:** set `SLACK_WEBHOOK_URL` to an [incoming webhook](https://api.slack.com/messaging/webhooks) URL.
  - **Webhook:** POST to `ALERT_WEBHOOK_URL` as `{ type: "mimir.alert", alert, observation, judgment, source }`.

### API

| method | path | |
| --- | --- | --- |
| GET | `/health` | |
| GET | `/source-types` | available adapters |
| GET/POST | `/themes` | `{ name, description?, keywords? }` |
| DELETE | `/themes/:id` | |
| GET/POST | `/trades` | `{ name, thesis?, keywords?, tickers?, strengthens?, weakens? }` |
| DELETE | `/trades/:id` | |
| GET/POST | `/entities` | `{ name, kind?: ticker\|company\|person\|project\|regulation\|other, aliases? }` |
| DELETE | `/entities/:id` | |
| GET/POST | `/sources` | `{ type, name, config, enabled?, weight?, pollIntervalSeconds? }` |
| PATCH/DELETE | `/sources/:id` | PATCH `{ enabled }` |
| POST | `/sources/:id/run` | run one source now |
| POST | `/ingest` | `{ source?, items: [{ id?, title, url?, summary?, publishedAt? }] }` |
| GET | `/observations?limit=` | recent items with judgments |
| GET | `/alerts?limit=` | recent alerts |

```bash
curl -X POST localhost:3000/entities -H 'content-type: application/json' \
  -d '{"name":"NVDA","kind":"ticker","aliases":["Nvidia"]}'
curl -X POST localhost:3000/sources -H 'content-type: application/json' \
  -d '{"type":"google-news","name":"Nvidia news","config":{"query":"Nvidia when:1d"}}'
```

## CI/CD

- **CI:** `.github/workflows/ci.yml` runs lint, typecheck, tests and build on every PR and push to `main`.
- **CD (pull-based):** the server deploys itself. `mimir-deploy.timer` runs [`deploy/deploy.sh`](deploy/deploy.sh) every 2 minutes; when `main` has a new commit it clones it into `/opt/mimir/releases/<sha>`, runs `npm ci`, tests and build as the `mimir` user, points `/opt/mimir/current` at it, restarts `mimir.service`, and rolls back if `/health` doesn't come up. A failing commit is marked `<sha>.failed` and not retried. No deploy credentials live in GitHub.
- **Server layout:** Node in `/opt/node`, env in `/etc/mimir.env`, SQLite in `/var/lib/mimir`, units in [`deploy/`](deploy/). Logs: `journalctl -u mimir -u mimir-deploy`.

## Alert quality eval

`npm run eval` scores the labelled headlines in `test/fixtures/eval.json` (real items from our sources, plus a few marked `synthetic`) and reports Bark precision and recall. It uses the LLM scorer when `LLM_API_KEY` is set and the heuristic otherwise. It runs offline with no delivery channels, so run it after any scoring change.
