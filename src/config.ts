export interface NtfyConfig {
  url: string;
  topic: string;
  token?: string;
}

export interface Config {
  port: number;
  databaseUrl: string;
  tursoAuthToken?: string;
  userAgent: string;
  pollIntervalSeconds: number;
  alertWebhookUrl?: string;
  ntfy?: NtfyConfig;
  alertThreshold: number;
  weakSignalFloor: number;
  accumulationThreshold: number;
  accumulationWindowHours: number;
  seedDefaults: boolean;
  llm?: { apiKey: string; baseUrl: string; model: string };
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Invalid number: ${value}`);
  return n;
}

function str(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llmKey = str(env.LLM_API_KEY);
  const ntfyTopic = str(env.NTFY_TOPIC);
  return {
    port: num(env.PORT, 3000),
    databaseUrl: str(env.DATABASE_URL) ?? "file:mimir.db",
    tursoAuthToken: str(env.TURSO_AUTH_TOKEN),
    userAgent: str(env.USER_AGENT) ?? "Mimir/0.1 (contact: unset)",
    pollIntervalSeconds: num(env.POLL_INTERVAL_SECONDS, 900),
    alertWebhookUrl: str(env.ALERT_WEBHOOK_URL),
    ntfy: ntfyTopic
      ? { url: str(env.NTFY_URL) ?? "https://ntfy.sh", topic: ntfyTopic, token: str(env.NTFY_TOKEN) }
      : undefined,
    alertThreshold: num(env.ALERT_THRESHOLD, 0.6),
    weakSignalFloor: num(env.WEAK_SIGNAL_FLOOR, 0.2),
    accumulationThreshold: num(env.ACCUMULATION_THRESHOLD, 1.2),
    accumulationWindowHours: num(env.ACCUMULATION_WINDOW_HOURS, 72),
    seedDefaults: env.SEED_DEFAULTS !== "false",
    llm: llmKey
      ? {
          apiKey: llmKey,
          baseUrl: str(env.LLM_BASE_URL) ?? "https://api.openai.com/v1",
          model: str(env.LLM_MODEL) ?? "gpt-4o-mini",
        }
      : undefined,
  };
}
