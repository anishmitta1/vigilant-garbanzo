import { z } from "zod";
import { defineAdapter } from "./types.js";

/** Items are pushed in via `POST /ingest`; nothing to poll. */
export const pushAdapter = defineAdapter({
  type: "push",
  description: "Inbound source: anything (scripts, Zapier, other scrapers) can POST items to /ingest.",
  configSchema: z.object({}).default({}),
  async fetch() {
    return [];
  },
});
