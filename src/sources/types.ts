import type { z } from "zod";
import type { RawItem } from "../types.js";

export interface SourceContext {
  fetch: typeof fetch;
  userAgent: string;
}

export interface SourceAdapter<C = unknown> {
  type: string;
  description: string;
  configSchema: z.ZodType<C>;
  /** Treat identical titles under different URLs as duplicates (default true). */
  dedupeByTitle?: boolean;
  fetch(config: C, ctx: SourceContext): Promise<RawItem[]>;
}

export const defineAdapter = <C>(adapter: SourceAdapter<C>): SourceAdapter<C> => adapter;
