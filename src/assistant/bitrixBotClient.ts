/**
 * Клиент чат-бота Bitrix24 (Chatbots 2.0, `imbot.v2.*`) через входящий вебхук с правом `imbot`.
 * Режим доставки `fetch`: бот сам опрашивает события, публичный адрес не нужен.
 * Адрес вебхука содержит секрет, поэтому в тексты ошибок он не попадает.
 */

export interface BotEvent {
  eventId: number;
  type: string;
  date: string;
  data: unknown;
}

export interface EventsPage {
  events: BotEvent[];
  nextOffset: number | null;
  hasMore: boolean;
}

export interface IncomingMessage {
  eventId: number;
  dialogId: string;
  chatType: string;
  /** Название группового чата; у чата сделки оно повторяет название сделки. */
  chatName: string;
  entityType: string;
  /** Номер сделки, если чат привязан к сделке CRM. */
  dealId: number | null;
  /** Гость портала, бот или отключённый пользователь: такому открытый доступ «для всех сотрудников» не даётся. */
  isExternal: boolean;
  messageId: number;
  userId: number;
  text: string;
}

export class BitrixBotError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "BitrixBotError";
  }
}

export interface BitrixBotClientOptions {
  webhookUrl: string;
  botToken: string;
  fetchFn?: typeof fetch;
}

const DEFAULT_EVENT_LIMIT = 100;
const MESSAGE_ADD_EVENT = "ONIMBOTV2MESSAGEADD";

export class BitrixBotClient {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: BitrixBotClientOptions) {
    this.baseUrl = options.webhookUrl.endsWith("/") ? options.webhookUrl : `${options.webhookUrl}/`;
    this.botToken = options.botToken;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Повторная регистрация с тем же `code` идемпотентна: вернётся уже существующий бот. */
  async register(input: { code: string; name: string; workPosition?: string }): Promise<number> {
    const properties: Record<string, string> = { name: input.name };
    if (input.workPosition) properties.workPosition = input.workPosition;

    const result = await this.call("imbot.v2.Bot.register", {
      fields: { code: input.code, botToken: this.botToken, type: "bot", eventMode: "fetch", properties }
    });
    const botId = Number(readPath(result, ["bot", "id"]));
    if (!Number.isFinite(botId)) throw new BitrixBotError("imbot.v2.Bot.register: no bot id in response", "BAD_RESPONSE", 200);
    return botId;
  }

  /** `offset` подтверждает обработанные события; на первом вызове его не передают. */
  async pollEvents(input: { botId: number; offset?: number; limit?: number }): Promise<EventsPage> {
    const body: Record<string, unknown> = { botId: input.botId, botToken: this.botToken, limit: input.limit ?? DEFAULT_EVENT_LIMIT };
    if (input.offset !== undefined) body.offset = input.offset;

    const result = await this.call("imbot.v2.Event.get", body);
    const events = readPath(result, ["events"]);
    const nextOffset = readPath(result, ["nextOffset"]);
    return {
      events: Array.isArray(events) ? (events as BotEvent[]) : [],
      nextOffset: typeof nextOffset === "number" ? nextOffset : null,
      hasMore: readPath(result, ["hasMore"]) === true
    };
  }

  async sendMessage(input: { botId: number; dialogId: string; text: string }): Promise<number> {
    const result = await this.call("imbot.v2.Chat.Message.send", {
      botId: input.botId,
      botToken: this.botToken,
      dialogId: input.dialogId,
      fields: { message: input.text, urlPreview: false }
    });
    return Number(readPath(result, ["id"]));
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      throw new BitrixBotError(`${method}: network error`, "NETWORK", 0);
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const code = typeof payload?.error === "string" && payload.error ? payload.error : null;
    if (!response.ok || code) {
      const description = typeof payload?.error_description === "string" ? payload.error_description : `HTTP ${response.status}`;
      throw new BitrixBotError(`${method}: ${description}`, code ?? `HTTP_${response.status}`, response.status);
    }
    return payload?.result;
  }
}

/** Новые сообщения пользователей из страницы событий: пустые и чужие типы событий отбрасываются. */
export function extractUserMessages(events: BotEvent[]): IncomingMessage[] {
  const messages: IncomingMessage[] = [];
  for (const event of events) {
    if (event.type !== MESSAGE_ADD_EVENT) continue;

    const text = stripMentions(String(readPath(event.data, ["message", "text"]) ?? "")).trim();
    const dialogId = String(readPath(event.data, ["chat", "dialogId"]) ?? "");
    const messageId = Number(readPath(event.data, ["message", "id"]));
    const userId = Number(readPath(event.data, ["user", "id"]) ?? readPath(event.data, ["message", "authorId"]));
    if (!text || !dialogId || !Number.isFinite(messageId) || !Number.isFinite(userId)) continue;

    messages.push({
      eventId: event.eventId,
      dialogId,
      chatType: String(readPath(event.data, ["chat", "type"]) ?? ""),
      chatName: String(readPath(event.data, ["chat", "name"]) ?? ""),
      entityType: String(readPath(event.data, ["chat", "entityType"]) ?? ""),
      dealId: dealIdFromChat(readPath(event.data, ["chat"])),
      isExternal: readPath(event.data, ["user", "extranet"]) === true || readPath(event.data, ["user", "bot"]) === true || readPath(event.data, ["user", "active"]) === false,
      messageId,
      userId,
      text
    });
  }
  return messages;
}

/** `[USER=2379]Помощник[/USER]` → `Помощник`: модели нужен чистый вопрос без разметки Bitrix. */
function stripMentions(text: string): string {
  return text.replace(/\[USER=\d+[^\]]*\]([^[]*)\[\/USER\]/gi, "$1");
}

/** Сделка чата: `DEAL|123` в entityId или entityData1, либо ссылка `/crm/deal/details/123/`. */
function dealIdFromChat(chat: unknown): number | null {
  const candidates = [readPath(chat, ["entityId"]), readPath(chat, ["entityData1"])];
  for (const candidate of candidates) {
    const match = /(?:^|\|)DEAL\|(\d+)/i.exec(String(candidate ?? ""));
    if (match) return Number(match[1]);
  }
  const link = /\/crm\/deal\/details\/(\d+)/i.exec(String(readPath(chat, ["entityLink", "url"]) ?? ""));
  return link ? Number(link[1]) : null;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
