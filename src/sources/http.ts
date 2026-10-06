import type { SourceContext } from "./types.js";

const TIMEOUT_MS = 20_000;

export async function httpGet(
  ctx: SourceContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await ctx.fetch(url, {
    headers: { "User-Agent": ctx.userAgent, Accept: "*/*", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

export async function httpGetJson(
  ctx: SourceContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  return JSON.parse(await httpGet(ctx, url, { Accept: "application/json", ...headers }));
}

/** Read a dotted path like `data.items.0.title` from a JSON value. */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
