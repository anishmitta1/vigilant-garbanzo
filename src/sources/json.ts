import { z } from "zod";
import type { RawItem } from "../types.js";
import { asString, getPath, httpGetJson } from "./http.js";
import { defineAdapter } from "./types.js";

export const jsonAdapter = defineAdapter({
  type: "json",
  description: "Any JSON API: point `itemsPath` at the array and map fields with dotted paths.",
  configSchema: z.object({
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    itemsPath: z.string().optional(),
    fields: z.object({
      id: z.string().optional(),
      title: z.string(),
      url: z.string().optional(),
      summary: z.string().optional(),
      publishedAt: z.string().optional(),
    }),
  }),
  async fetch(config, ctx) {
    const body = await httpGetJson(ctx, config.url, config.headers);
    const items = getPath(body, config.itemsPath);
    if (!Array.isArray(items)) throw new Error(`itemsPath "${config.itemsPath ?? ""}" is not an array`);
    const f = config.fields;
    return items.map((item): RawItem => {
      const title = asString(getPath(item, f.title)) ?? "";
      const url = f.url ? asString(getPath(item, f.url)) : undefined;
      return {
        externalId: (f.id ? asString(getPath(item, f.id)) : undefined) ?? url ?? title,
        title,
        url,
        summary: f.summary ? asString(getPath(item, f.summary)) : undefined,
        publishedAt: f.publishedAt ? asString(getPath(item, f.publishedAt)) : undefined,
        raw: item,
      };
    });
  },
});
