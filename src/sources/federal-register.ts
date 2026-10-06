import { z } from "zod";
import type { RawItem } from "../types.js";
import { httpGetJson } from "./http.js";
import { defineAdapter } from "./types.js";

interface Doc {
  document_number: string;
  title: string;
  abstract?: string | null;
  html_url: string;
  publication_date?: string;
  type?: string;
  agencies?: { name?: string }[];
}

export const federalRegisterAdapter = defineAdapter({
  type: "federal-register",
  description: "US Federal Register documents (rules, proposed rules, notices, presidential documents).",
  configSchema: z.object({
    term: z.string().optional(),
    agencies: z.array(z.string()).default([]),
    documentTypes: z.array(z.enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"])).default([]),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async fetch(config, ctx) {
    const url = new URL("https://www.federalregister.gov/api/v1/documents.json");
    url.searchParams.set("per_page", String(config.limit));
    url.searchParams.set("order", "newest");
    if (config.term) url.searchParams.set("conditions[term]", config.term);
    for (const a of config.agencies) url.searchParams.append("conditions[agencies][]", a);
    for (const t of config.documentTypes) url.searchParams.append("conditions[type][]", t);
    const body = (await httpGetJson(ctx, url.toString())) as { results?: Doc[] };
    return (body.results ?? []).map(
      (d): RawItem => ({
        externalId: d.document_number,
        title: d.title,
        url: d.html_url,
        summary: d.abstract ?? undefined,
        publishedAt: d.publication_date,
        raw: { type: d.type, agencies: d.agencies?.map((a) => a.name) },
      }),
    );
  },
});
