/**
 * Обработка одного входящего сообщения: доступ, дневные лимиты, вопрос ассистенту, ответ в чат.
 * Тексты ошибок для сотрудника не содержат внутренностей (ключи, адреса, стек).
 */

import type { IncomingMessage } from "./bitrixBotClient.js";
import type { DailyUsageLimiter } from "./usageLimits.js";

const MAX_REPLY_CHARS = 19_000;

export interface AssistantDeps {
  allowedUserIds: Set<number>;
  /** Открытый доступ: отвечать любому сотруднику, кроме гостей и ботов. Явный список всё равно работает. */
  allowAllEmployees: boolean;
  limiter: DailyUsageLimiter;
  ask(text: string, userId: number): Promise<{ text: string }>;
  send(dialogId: string, text: string): Promise<void>;
  now(): number;
  log(line: string): void;
}

/** В групповом чате «эта сделка» значит сделку этого чата, поэтому вопросу добавляется контекст чата. */
function questionWithChatContext(message: IncomingMessage): string {
  if (message.chatType === "private") return message.text;
  const name = message.chatName ? ` «${message.chatName}»` : "";
  const deal = message.dealId
    ? `Чат привязан к сделке ${message.dealId}: слова «эта сделка» относятся к ней, открой её через get_deal.`
    : "Если речь об «этой сделке», найди её через find_deals по названию чата: оно повторяет название сделки (например, по номеру в квадратных скобках).";
  return `[Сообщение из группового чата${name}. ${deal}]\n${message.text}`;
}

export async function handleIncomingMessage(message: IncomingMessage, deps: AssistantDeps): Promise<void> {
  const reply = (text: string) => deps.send(message.dialogId, text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text);

  deps.log(`message ${message.messageId}: chat ${message.chatType}${message.entityType ? `/${message.entityType}` : ""}, deal ${message.dealId ?? "-"}, external ${message.isExternal}`);

  const allowed = deps.allowedUserIds.has(message.userId) || (deps.allowAllEmployees && !message.isExternal);
  if (!allowed) {
    deps.log(`message ${message.messageId}: user ${message.userId} is not allowed`);
    await reply("У вас нет доступа к помощнику. Обратитесь к администратору Bitrix24.");
    return;
  }

  const slot = deps.limiter.tryConsume(message.userId, deps.now());
  if (!slot.allowed) {
    deps.log(`message ${message.messageId}: ${slot.reason} limit reached for user ${message.userId}`);
    await reply(
      slot.reason === "total"
        ? "Общий дневной лимит запросов к помощнику исчерпан. Попробуйте завтра."
        : "Ваш дневной лимит запросов к помощнику исчерпан. Он обновится завтра."
    );
    return;
  }

  try {
    const answer = await deps.ask(questionWithChatContext(message), message.userId);
    await reply(answer.text.trim() || "Не нашёл, что ответить. Попробуйте переформулировать вопрос.");
  } catch (error) {
    deps.log(`message ${message.messageId}: assistant failed: ${error instanceof Error ? error.name : "error"}`);
    await reply("Не получилось обработать запрос. Попробуйте ещё раз чуть позже.");
  }
}
