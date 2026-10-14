/**
 * Настройки помощника из переменных окружения (локально — из `.env`).
 * В сообщениях об ошибках только имена переменных, значения не показываются.
 */

export const DEFAULT_ASSISTANT_MODEL = "claude-haiku-5-5";
const MAX_BOT_TOKEN_LENGTH = 40; // ограничение Bitrix24 на botToken

export interface BotConfig {
  webhookUrl: string;
  token: string;
  botId: number | null;
}

export interface AssistantConfig {
  anthropicApiKey: string;
  model: string;
  crmWebhookUrl: string;
  goszakupToken: string;
  /** Кому можно писать боту. Пусто и без звёздочки — никому: доступ выдаётся явно. */
  allowedUserIds: number[];
  /** `ASSISTANT_ALLOWED_USER_IDS=*`: отвечать любому сотруднику портала (не гостю и не боту). */
  allowAllEmployees: boolean;
  perUserPerDay: number;
  totalPerDay: number;
  pollIntervalMs: number;
  /** Есть только когда заданы вебхук бота и его токен; для локальной проверки `--ask` бот не нужен. */
  bot: BotConfig | null;
}

type Env = Record<string, string | undefined>;

export function loadAssistantConfig(env: Env = process.env): AssistantConfig {
  const botWebhook = optional(env, "BITRIX_BOT_WEBHOOK_URL");
  const botToken = optional(env, "BITRIX_BOT_TOKEN");
  if (botToken && botToken.length > MAX_BOT_TOKEN_LENGTH) {
    throw new Error(`BITRIX_BOT_TOKEN длиннее ${MAX_BOT_TOKEN_LENGTH} символов, Bitrix24 такой не примет`);
  }
  const botId = Number(optional(env, "BITRIX_BOT_ID"));

  return {
    anthropicApiKey: required(env, "ANTHROPIC_API_KEY"),
    model: optional(env, "ASSISTANT_MODEL") ?? DEFAULT_ASSISTANT_MODEL,
    crmWebhookUrl: required(env, "BITRIX_CRM_WEBHOOK_URL"),
    goszakupToken: required(env, "GOSZAKUP_TOKEN"),
    allowedUserIds: parseIds(optional(env, "ASSISTANT_ALLOWED_USER_IDS")),
    allowAllEmployees: (optional(env, "ASSISTANT_ALLOWED_USER_IDS") ?? "").split(",").some((part) => part.trim() === "*"),
    perUserPerDay: positive(env, "ASSISTANT_DAILY_LIMIT_PER_USER", 30),
    totalPerDay: positive(env, "ASSISTANT_DAILY_LIMIT_TOTAL", 200),
    pollIntervalMs: positive(env, "ASSISTANT_POLL_INTERVAL_MS", 3000),
    bot: botWebhook && botToken ? { webhookUrl: botWebhook, token: botToken, botId: Number.isInteger(botId) && botId > 0 ? botId : null } : null
  };
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (!value) throw new Error(`Не задана переменная ${name}`);
  return value;
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Переменная ${name} должна быть положительным числом`);
  return value;
}

function parseIds(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}
