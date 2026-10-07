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
- Optional LLM scorer: set `LLM_API_KEY` (any OpenAI-compatible API, see `LLM_BASE_URL` and `LLM_MODEL`; defaults to `deepseek/deepseek-v4.1-flash` on OpenRouter). If the call fails, scoring falls back to the heuristic.
- Alerts: `consequence >= ALERT_THRESHOLD` alerts directly. Weak signals (`>= WEAK_SIGNAL_FLOOR`) accumulate per target over `ACCUMULATION_WINDOW_HOURS`, and an alert fires once a target's total reaches `ACCUMULATION_THRESHOLD`. Items published more than `MAX_ALERT_AGE_HOURS` (default 48) ago are stored and scored but never alert or accumulate, so a new source's backlog doesn't page you. A source's first poll is a silent baseline (stored and scored, no alerts). After an alert on a target, further alerts on it are held for `ALERT_COOLDOWN_HOURS` (default 6) unless a direct alert scores at least `COOLDOWN_BYPASS_SCORE` (default 0.9). An alert whose headline matches a story already alerted on within `STORY_WINDOW_HOURS` (default 48), from any outlet, is skipped. Bark is the "drop everything" channel: it only receives direct alerts scoring at least `BARK_MIN_SCORE` (default 0.8). With `LLM_API_KEY` set, the model's verdict replaces the score thresholds: an item alerts directly (and goes to Bark) only if the model says `material: true` with consequence of at least `MATERIAL_MIN_SCORE` (default 0.5). Material alerts skip the per-target cooldown, and LLM judgments never accumulate. Reasoning is off by default (`LLM_REASONING`), which measured both cheapest and most accurate on the eval set. Every fresh item goes to the model, including aggregator items with no keyword match, since a keyword pre-filter silently drops consequential stories phrased differently (backlog, first-poll and stale items still skip it). If a model call fails (including a spend limit set on the provider side), the item falls back to the heuristic, which can't push to Bark, and the daily digest flags it. Alerts are stored and delivered to every configured channel:
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

### Daily digest

With `BARK_URL` set, Mimir sends one Bark push a day at `DIGEST_TIME` (default `16:00`) in `DIGEST_TZ` (default `America/Los_Angeles`). It covers everything since the previous digest: the alerts that fired, the strongest items that didn't (near-misses: the model called them material but below the bar, or scored them 0.3+ while saying not material), items read, model calls, and any failing sources. It is the place to spot misses. If Mimir is down at the scheduled time, the digest goes out when it comes back the same day. Set `DIGEST_TIME=off` to disable it. `npm run digest` prints the digest for the last 24 hours (`DIGEST_HOURS` to change) from `DATABASE_URL`; add `-- --send` to push it. The digest also scores the day against the market: for each trade, free daily closes (Yahoo chart API) for its tickers give a basket move (average absolute return), and a session moving at least 2.5× its 60-session median is a "big day". It shows whether a push on that trade came between the previous close and that close, or the closest unpushed item if not, plus a 30-day line (big days caught, pushes on quiet days) and the median publish-to-alert latency. A big day is a candidate catalyst, not proof of a miss. `--no-market` skips prices.

### Replay

### Events and pillars

Each trade rests on pillars: short axioms like "Compute is scarce.", each with example signals rated `slightly_supports`, `majorly_supports`, `slightly_falsifies` or `majorly_falsifies`. Pillars are written by a person (presets seed defaults; `POST /trades/:id/pillars` adds one, `PATCH /pillars/:id {"active": false}` retires one). The model scores against them but never edits them. Retired pillars stop being scored, and their past evidence is kept.

With `EVENT_GROUPING` on (default), every item is placed in an event, one real-world development however many outlets report it. Exact copies are dropped on arrival as before. A small local embedding model (`Xenova/all-MiniLM-L6-v2`, about 25 MB, downloaded on first use, a few ms per headline on CPU) finds the three closest open events from the last 72h, even if similarity is low. Those, plus every event alerted on in the last 48h, are offered to the model in the call it already makes per item, and it says whether the item reports on one of them. Items without a model verdict (backlog, first polls) merge only into near-identical events. The same call returns the item's pillar impacts. The model sees each pillar's recent evidence, so several slight moves can make the next one major without any stored "pillar status". An event records each pillar move once, so rewrites never count twice. Impacts that fit no pillar (`pillar: null`) are listed in the daily digest as a cue to add a pillar.

Re-reports are held (`same_event`), whether or not the event has been alerted on. They add a source but never add or upgrade an impact, trigger a push, or accumulate as another weak signal. A follow-up with materially new facts is a new event, not a re-report. Every event alerted on in the last 48h remains a candidate even after other pushes arrive or local embeddings fail. On first deployment, the server silently groups recent legacy pushes into event memory before polling resumes; it links their original alert records without repeating deliveries. The health endpoint is available during this warm-start.

The scorer receives dated, distinct event-level evidence with rationales for the last 14 days, plus trade-level evidence that fit no axiom. Prompt examples are bounded (up to eight per pillar or trade-level gap, prioritizing major moves), with distinct-event counts for the complete window. This is derived context, not stored pillar status. `ALERT_MODE=events` (default `legacy`) switches pushes from material verdicts to pillar moves: an item pushes when it gives a new event a `majorly_supports` or `majorly_falsifies` impact.

`npm run replay -- --db <copy of mimir.db>` replays every stored item through the current pipeline, in fetch order with the clock set to each item's fetch time, so cooldowns, same-story holds, staleness and first-poll silence behave as they did live. It reuses production's saved model verdicts (free and deterministic) and reports pushes per day, holds, near-misses, latency and big market days caught or missed. `--bars 0.45,0.55` sweeps `MATERIAL_MIN_SCORE`. `--rescore` re-asks the model about items it called material or scored 0.3+ (for prompt changes; `--rescore-all` for everything), caching fresh verdicts by title in `.replay-cache.json`. `--json <file>` writes the results. `--events` turns on event grouping and `--mode events` also uses the events push rule; both need fresh verdicts, so they re-ask the model about every item (cached separately in `.replay-cache-events.json`) and add an events and pillar-impact report. Grouped cache entries are scoped to the observation, model prompt, axioms and event/evidence context, with event and pillar references remapped across scratch databases; old title-only grouped caches are ignored. The input file is never modified: replay works on a temporary copy, configures no delivery channel, and fails any network call from the pipeline.

`npm run eval` scores the labelled headlines in `test/fixtures/eval.json` (real items from our sources, plus a few marked `synthetic`) and reports Bark precision and recall. It uses the LLM scorer when `LLM_API_KEY` is set and the heuristic otherwise. It runs offline with no delivery channels, so run it after any scoring change.
