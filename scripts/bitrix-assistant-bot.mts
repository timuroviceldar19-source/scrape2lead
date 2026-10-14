/**
 * Чат-бот-помощник по закупкам в Bitrix24 (только чтение: сделки, API и страницы портала).
 *
 *   npm run assistant -- --ask "оцени сделку 48311"       локальная проверка, бот в Bitrix не нужен
 *   npm run assistant -- --register                        показать, что будет создано (без записи)
 *   npm run assistant -- --register --execute              создать бота в Bitrix24 (боевое действие)
 *   npm run assistant                                      рабочий цикл: опрос чата и ответы
 *   npm run assistant -- --once                            один опрос и выход
 *
 * Настройки и секреты читаются из `.env` (имена см. src/assistant/config.ts), в вывод они не попадают.
 */

import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import type { AgentClient } from "../src/assistant/agent.js";
import { handleIncomingMessage, type AssistantDeps } from "../src/assistant/assistantService.js";
import { BitrixBotClient } from "../src/assistant/bitrixBotClient.js";
import { createPollState, pollOnce } from "../src/assistant/botLoop.js";
import { loadAssistantConfig, type AssistantConfig } from "../src/assistant/config.js";
import { createAssistant, createPdfExtractor } from "../src/assistant/createAssistant.js";
import { CrmReader } from "../src/assistant/crmReader.js";
import { GoszakupApi } from "../src/assistant/goszakupApi.js";
import { fetchAnnouncementContacts, loadSpecFile } from "../src/assistant/portalReaders.js";
import { DailyUsageLimiter } from "../src/assistant/usageLimits.js";

dotenv.config();

const BOT_CODE = "gz_assistant";
const BOT_NAME = "Помощник по закупкам";
const BOT_POSITION = "ИИ-помощник отдела продаж";
const MAX_BACKOFF_MS = 30_000;

interface Args {
  ask: string | null;
  user: number;
  register: boolean;
  execute: boolean;
  once: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ask: null, user: 0, register: false, execute: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ask") args.ask = argv[++i] ?? "";
    else if (arg === "--user") args.user = Number(argv[++i]);
    else if (arg === "--register") args.register = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--once") args.once = true;
    else throw new Error(`Неизвестный параметр: ${arg}`);
  }
  return args;
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

/** Токены отдельных запросов на чтение PDF: их нет в итоге основного цикла. */
const pdfUsage = { inputTokens: 0, outputTokens: 0 };

// Цена Claude Haiku 5.5 для запросов до 100 тыс. токенов (platform.claude.com/docs/en/about-claude/pricing), $ за 1 млн токенов.
const PRICE_PER_MTOK = { input: 0.1, output: 0.5 };

// Один поиск в интернете стоит $10 за 1000 (platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).
const PRICE_PER_WEB_SEARCH = 0.01;

function costUsd(inputTokens: number, outputTokens: number, webSearches = 0): number {
  return (inputTokens * PRICE_PER_MTOK.input + outputTokens * PRICE_PER_MTOK.output) / 1_000_000 + webSearches * PRICE_PER_WEB_SEARCH;
}

function buildAssistant(config: AssistantConfig) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey }) as unknown as AgentClient;
  return createAssistant({
    client,
    model: config.model,
    toolDeps: {
      crm: new CrmReader({ webhookUrl: config.crmWebhookUrl }),
      goszakup: new GoszakupApi({ token: config.goszakupToken }),
      portal: { fetchAnnouncementContacts: (id) => fetchAnnouncementContacts(id), loadSpecFile: (url) => loadSpecFile(url) },
      extractFromPdf: createPdfExtractor(client, config.model, (usage) => {
        pdfUsage.inputTokens += usage.inputTokens;
        pdfUsage.outputTokens += usage.outputTokens;
      })
    }
  });
}

async function runAsk(config: AssistantConfig, question: string, userId: number): Promise<void> {
  const result = await buildAssistant(config).ask(question, userId);
  const input = result.usage.inputTokens + pdfUsage.inputTokens;
  const output = result.usage.outputTokens + pdfUsage.outputTokens;
  console.log(result.text);
  console.log(
    `\n[модель ${config.model}; инструменты: ${result.toolCalls.join(", ") || "нет"}; шагов ${result.turns}; ` +
      `токены с чтением PDF: вход ${input}, выход ${output}; поисков в интернете ${result.webSearches}; примерно ${costUsd(input, output, result.webSearches).toFixed(4)} $]`
  );
}

async function runRegister(config: AssistantConfig, execute: boolean): Promise<void> {
  if (!config.bot) throw new Error("Для регистрации нужны BITRIX_BOT_WEBHOOK_URL и BITRIX_BOT_TOKEN в .env");
  if (!execute) {
    log(`dry-run: был бы зарегистрирован бот code=${BOT_CODE}, name="${BOT_NAME}" (добавьте --execute, чтобы создать)`);
    return;
  }
  const bot = new BitrixBotClient({ webhookUrl: config.bot.webhookUrl, botToken: config.bot.token });
  const botId = await bot.register({ code: BOT_CODE, name: BOT_NAME, workPosition: BOT_POSITION });
  log(`бот зарегистрирован, id=${botId}. Добавьте в .env строку BITRIX_BOT_ID=${botId}`);
}

async function runBot(config: AssistantConfig, once: boolean): Promise<void> {
  if (!config.bot?.botId) throw new Error("Не заданы BITRIX_BOT_WEBHOOK_URL, BITRIX_BOT_TOKEN или BITRIX_BOT_ID (выдаёт --register --execute)");
  const { botId } = config.bot;
  const bot = new BitrixBotClient({ webhookUrl: config.bot.webhookUrl, botToken: config.bot.token });
  const assistant = buildAssistant(config);

  const deps: AssistantDeps = {
    allowedUserIds: new Set(config.allowedUserIds),
    allowAllEmployees: config.allowAllEmployees,
    limiter: new DailyUsageLimiter({ perUserPerDay: config.perUserPerDay, totalPerDay: config.totalPerDay }),
    ask: async (text, userId) => {
      const before = { ...pdfUsage };
      const result = await assistant.ask(text, userId);
      const input = result.usage.inputTokens + pdfUsage.inputTokens - before.inputTokens;
      const output = result.usage.outputTokens + pdfUsage.outputTokens - before.outputTokens;
      log(`ответ готов: пользователь ${userId}, инструменты [${result.toolCalls.join(", ")}], токены ${input}/${output}, поисков в интернете ${result.webSearches}, примерно ${costUsd(input, output, result.webSearches).toFixed(4)} $`);
      return result;
    },
    send: async (dialogId, text) => void (await bot.sendMessage({ botId, dialogId, text })),
    now: () => Date.now(),
    log
  };

  const state = createPollState();
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));

  log(`бот запущен: id=${botId}, модель ${config.model}, доступ: ${config.allowAllEmployees ? "все сотрудники" : `${config.allowedUserIds.length} чел.`}, лимиты ${config.perUserPerDay}/${config.totalPerDay} в сутки`);
  if (config.allowedUserIds.length === 0 && !config.allowAllEmployees) log("ВНИМАНИЕ: ASSISTANT_ALLOWED_USER_IDS пуст, бот будет отвечать всем отказом");

  let backoff = config.pollIntervalMs;
  while (!stopping) {
    try {
      const { hasMore } = await pollOnce({
        bot,
        botId,
        state,
        handle: (message) => handleIncomingMessage(message, deps),
        onError: (error) => log(`сообщение не обработано: ${error instanceof Error ? error.name : "ошибка"}`)
      });
      backoff = config.pollIntervalMs;
      if (once) return;
      if (!hasMore) await sleep(config.pollIntervalMs);
    } catch (error) {
      if (once) throw error;
      log(`опрос не удался (${error instanceof Error ? error.message : "ошибка"}), повтор через ${Math.round(backoff / 1000)} с`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  log("бот остановлен");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadAssistantConfig();
  if (args.ask !== null) return runAsk(config, args.ask, args.user);
  if (args.register) return runRegister(config, args.execute);
  return runBot(config, args.once);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
