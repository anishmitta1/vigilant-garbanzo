export interface NtfyConfig {
  url: string;
  topic: string;
  token?: string;
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  tursoAuthToken?: string;
  userAgent: string;
  pollIntervalSeconds: number;
  alertWebhookUrl?: string;
  ntfy?: NtfyConfig;
  barkUrl?: string;
  barkMinScore: number;
  slackWebhookUrl?: string;
  alertThreshold: number;
  weakSignalFloor: number;
  accumulationThreshold: number;
  accumulationWindowHours: number;
  maxAlertAgeHours: number;
  alertCooldownHours: number;
  cooldownBypassScore: number;
  materialMinScore: number;
  storyWindowHours: number;
  seedDefaults: boolean;
  /** Daily Bark digest at this local time ("HH:MM" in `digestTimeZone`); unset disables it. */
  digestTime?: string;
  digestTimeZone: string;
  llm?: { apiKey: string; baseUrl: string; model: string; maxCallsPerDay?: number; reasoning?: string; maxTokens?: number };
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

function digestTime(value: string | undefined): string | undefined {
  if (value === undefined) return "16:00";
  if (value === "" || value === "off") return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid DIGEST_TIME (want HH:MM): ${value}`);
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

function timeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(`Invalid DIGEST_TZ: ${value}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llmKey = str(env.LLM_API_KEY);
  const ntfyTopic = str(env.NTFY_TOPIC);
  return {
    port: num(env.PORT, 3000),
    host: str(env.HOST) ?? "0.0.0.0",
    databaseUrl: str(env.DATABASE_URL) ?? "file:mimir.db",
    tursoAuthToken: str(env.TURSO_AUTH_TOKEN),
    userAgent: str(env.USER_AGENT) ?? "Mimir/0.1 (contact: unset)",
    pollIntervalSeconds: num(env.POLL_INTERVAL_SECONDS, 900),
    alertWebhookUrl: str(env.ALERT_WEBHOOK_URL),
    barkUrl: str(env.BARK_URL),
    barkMinScore: num(env.BARK_MIN_SCORE, 0.8),
    slackWebhookUrl: str(env.SLACK_WEBHOOK_URL),
    ntfy: ntfyTopic
      ? { url: str(env.NTFY_URL) ?? "https://ntfy.sh", topic: ntfyTopic, token: str(env.NTFY_TOKEN) }
      : undefined,
    alertThreshold: num(env.ALERT_THRESHOLD, 0.6),
    weakSignalFloor: num(env.WEAK_SIGNAL_FLOOR, 0.2),
    accumulationThreshold: num(env.ACCUMULATION_THRESHOLD, 1.2),
    accumulationWindowHours: num(env.ACCUMULATION_WINDOW_HOURS, 72),
    maxAlertAgeHours: num(env.MAX_ALERT_AGE_HOURS, 48),
    alertCooldownHours: num(env.ALERT_COOLDOWN_HOURS, 6),
    cooldownBypassScore: num(env.COOLDOWN_BYPASS_SCORE, 0.9),
    materialMinScore: num(env.MATERIAL_MIN_SCORE, 0.5),
    storyWindowHours: num(env.STORY_WINDOW_HOURS, 48),
    seedDefaults: env.SEED_DEFAULTS !== "false",
    digestTime: digestTime(env.DIGEST_TIME),
    digestTimeZone: timeZone(str(env.DIGEST_TZ) ?? "America/Los_Angeles"),
    llm: llmKey
      ? {
          apiKey: llmKey,
          baseUrl: str(env.LLM_BASE_URL) ?? "https://openrouter.ai/api/v1",
          model: str(env.LLM_MODEL) ?? "deepseek/deepseek-v4.1-flash",
          maxCallsPerDay: num(env.LLM_MAX_CALLS_PER_DAY, 500),
          reasoning: str(env.LLM_REASONING) ?? "off",
          maxTokens: num(env.LLM_MAX_TOKENS, 1500),
        }
      : undefined,
  };
}
