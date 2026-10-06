import { load } from "cheerio";
import { z } from "zod";
import type { RawItem } from "../types.js";
import { httpGet } from "./http.js";
import { defineAdapter } from "./types.js";

/** Scrape any HTML listing page (press releases, regulator notices, IR pages) with CSS selectors. */
export const htmlAdapter = defineAdapter({
  type: "html",
  description: "Scrape any HTML listing page using CSS selectors (press-release pages, regulators, IR sites).",
  configSchema: z.object({
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    itemSelector: z.string().min(1),
    fields: z
      .object({
        title: z.string().optional(),
        link: z.string().optional(),
        summary: z.string().optional(),
        date: z.string().optional(),
        dateAttribute: z.string().optional(),
      })
      .default({}),
  }),
  async fetch(config, ctx) {
    const $ = load(await httpGet(ctx, config.url, config.headers));
    const f = config.fields;
    const items: RawItem[] = [];
    $(config.itemSelector).each((_, el) => {
      const item = $(el);
      const pick = (sel?: string) => (sel ? item.find(sel).first() : item);
      const title = pick(f.title).text().trim();
      const linkEl = f.link ? item.find(f.link).first() : item.is("a") ? item : item.find("a").first();
      const href = linkEl.attr("href");
      const url = href ? new URL(href, config.url).toString() : undefined;
      const dateEl = f.date ? item.find(f.date).first() : undefined;
      const date = dateEl ? (f.dateAttribute ? dateEl.attr(f.dateAttribute) : dateEl.text().trim()) : undefined;
      if (!title) return;
      items.push({
        externalId: url ?? title,
        title,
        url,
        summary: f.summary ? item.find(f.summary).first().text().trim() : undefined,
        publishedAt: date,
      });
    });
    return items;
  },
});
