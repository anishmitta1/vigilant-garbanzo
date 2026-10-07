import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "./db.js";
import { processItems, runSource, type PipelineDeps } from "./pipeline.js";
import { listAdapters, parseSourceConfig } from "./sources/registry.js";
import { EFFECTS, type Effect } from "./types.js";

const ThemeBody = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  keywords: z.array(z.string().min(1)).default([]),
});

const terms = z.array(z.string().min(1)).default([]);
const PillarBody = z.object({
  statement: z.string().min(1),
  signals: z
    .array(z.object({ description: z.string().min(1), effect: z.enum(EFFECTS as [Effect, ...Effect[]]) }))
    .default([]),
});

const TradeBody = z.object({
  name: z.string().min(1),
  thesis: z.string().default(""),
  keywords: terms,
  tickers: terms,
  strengthens: terms,
  weakens: terms,
  entities: z.array(z.object({ name: z.string().min(1), aliases: terms })).default([]),
  pillars: z.array(PillarBody).default([]),
});

const EntityBody = z.object({
  name: z.string().min(1),
  kind: z.enum(["ticker", "company", "person", "project", "regulation", "other"]).default("company"),
  aliases: z.array(z.string().min(1)).default([]),
});

const SourceBody = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.unknown().default({}),
  enabled: z.boolean().default(true),
  weight: z.number().min(0).max(2).default(1),
  pollIntervalSeconds: z.number().int().min(30).nullable().default(null),
});

const IngestBody = z.object({
  source: z.string().default("Inbound (POST /ingest)"),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        url: z.string().optional(),
        summary: z.string().optional(),
        publishedAt: z.string().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const Limit = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });
const IdParam = z.object({ id: z.string() });

export function buildServer(store: Store, deps: PipelineDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid_request", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: err instanceof Error ? err.message : String(err) });
  });

  const notFound = { error: "not_found" };

  app.get("/health", async () => ({ ok: true }));
  app.get("/source-types", async () => listAdapters());

  app.get("/themes", async () => store.listThemes());
  app.post("/themes", async (req, reply) => reply.status(201).send(await store.createTheme(ThemeBody.parse(req.body))));
  app.delete("/themes/:id", async (req, reply) =>
    (await store.deleteTheme(IdParam.parse(req.params).id)) ? reply.status(204).send() : reply.status(404).send(notFound),
  );

  app.get("/trades", async () => store.listTrades());
  app.post("/trades", async (req, reply) => reply.status(201).send(await store.createTrade(TradeBody.parse(req.body))));
  // Pillars are only ever added or retired (never edited in place), so past impacts keep their meaning.
  app.post("/trades/:id/pillars", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await store.listTrades()).some((t) => t.id === id)) return reply.status(404).send({ error: "not found" });
    return reply.status(201).send(await store.addPillar(id, PillarBody.parse(req.body)));
  });
  app.patch("/pillars/:id", async (req, reply) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const ok = await store.setPillarActive((req.params as { id: string }).id, active);
    return ok ? reply.status(204).send() : reply.status(404).send({ error: "not found" });
  });
  app.delete("/trades/:id", async (req, reply) =>
    (await store.deleteTrade(IdParam.parse(req.params).id)) ? reply.status(204).send() : reply.status(404).send(notFound),
  );

  app.get("/entities", async () => store.listEntities());
  app.post("/entities", async (req, reply) => reply.status(201).send(await store.createEntity(EntityBody.parse(req.body))));
  app.delete("/entities/:id", async (req, reply) =>
    (await store.deleteEntity(IdParam.parse(req.params).id)) ? reply.status(204).send() : reply.status(404).send(notFound),
  );

  app.get("/sources", async () => store.listSources());
  app.post("/sources", async (req, reply) => {
    const body = SourceBody.parse(req.body);
    const config = parseSourceConfig(body.type, body.config);
    return reply.status(201).send(await store.createSource({ ...body, config }));
  });
  app.patch("/sources/:id", async (req, reply) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    return (await store.setSourceEnabled(IdParam.parse(req.params).id, enabled))
      ? store.getSource(IdParam.parse(req.params).id)
      : reply.status(404).send(notFound);
  });
  app.delete("/sources/:id", async (req, reply) =>
    (await store.deleteSource(IdParam.parse(req.params).id)) ? reply.status(204).send() : reply.status(404).send(notFound),
  );
  app.post("/sources/:id/run", async (req, reply) => {
    const source = await store.getSource(IdParam.parse(req.params).id);
    return source ? runSource(deps, source) : reply.status(404).send(notFound);
  });

  app.post("/ingest", async (req) => {
    const body = IngestBody.parse(req.body);
    const source =
      (await store.findSourceByName(body.source)) ??
      (await store.createSource({ type: "push", name: body.source, config: {} }));
    const items = body.items.map((i) => ({ ...i, externalId: i.id ?? i.url ?? i.title }));
    return processItems(deps, source, items);
  });

  app.get("/observations", async (req) => store.listObservations(Limit.parse(req.query).limit));
  app.get("/alerts", async (req) => store.listAlerts(Limit.parse(req.query).limit));

  return app;
}
