import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const nowIso = (): string => new Date().toISOString();

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
