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
