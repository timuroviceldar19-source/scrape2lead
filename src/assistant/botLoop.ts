/**
 * Один шаг опроса событий бота. Bitrix считает события подтверждёнными, когда мы передаём
 * `offset` со следующим запросом, поэтому смещение сдвигается только после обработки страницы.
 * Если процесс упадёт посреди страницы, Bitrix отдаст её снова; от повторов защищает память о messageId.
 */

import { extractUserMessages, type EventsPage, type IncomingMessage } from "./bitrixBotClient.js";

const MAX_REMEMBERED_MESSAGES = 1000;

export interface PollState {
  offset: number | undefined;
  seenMessageIds: Set<number>;
}

export function createPollState(): PollState {
  return { offset: undefined, seenMessageIds: new Set() };
}

export interface PollOnceOptions {
  bot: { pollEvents(input: { botId: number; offset?: number }): Promise<EventsPage> };
  botId: number;
  handle(message: IncomingMessage): Promise<void>;
  state: PollState;
  onError?(error: unknown): void;
}

export async function pollOnce(options: PollOnceOptions): Promise<{ handled: number; hasMore: boolean }> {
  const { state } = options;
  const page = await options.bot.pollEvents({ botId: options.botId, ...(state.offset !== undefined ? { offset: state.offset } : {}) });

  let handled = 0;
  for (const message of extractUserMessages(page.events)) {
    if (state.seenMessageIds.has(message.messageId)) continue;
    remember(state, message.messageId);
    try {
      await options.handle(message);
      handled += 1;
    } catch (error) {
      options.onError?.(error);
    }
  }

  if (page.nextOffset !== null) state.offset = page.nextOffset;
  return { handled, hasMore: page.hasMore };
}

function remember(state: PollState, messageId: number): void {
  state.seenMessageIds.add(messageId);
  if (state.seenMessageIds.size > MAX_REMEMBERED_MESSAGES) {
    const oldest = state.seenMessageIds.values().next().value;
    if (oldest !== undefined) state.seenMessageIds.delete(oldest);
  }
}
