import { describe, expect, it } from "vitest";
import {
  BitrixBotClient,
  BitrixBotError,
  extractUserMessages,
  type BotEvent
} from "../../src/assistant/bitrixBotClient.js";

const WEBHOOK = "https://example.bitrix24.kz/rest/7/secretcode/";

interface Call {
  url: string;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; body: unknown }>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function client(responses: Array<{ status?: number; body: unknown }>) {
  const { fetchFn, calls } = fakeFetch(responses);
  return { bot: new BitrixBotClient({ webhookUrl: WEBHOOK, botToken: "tok", fetchFn }), calls };
}

describe("BitrixBotClient.register", () => {
  it("registers a fetch-mode bot and returns its id", async () => {
    const { bot, calls } = client([{ body: { result: { bot: { id: 456, code: "gz_assistant" } } } }]);

    const botId = await bot.register({ code: "gz_assistant", name: "Помощник по закупкам", workPosition: "ИИ-помощник" });

    expect(botId).toBe(456);
    expect(calls[0].url).toBe(`${WEBHOOK}imbot.v2.Bot.register`);
    expect(calls[0].body).toEqual({
      fields: {
        code: "gz_assistant",
        botToken: "tok",
        type: "bot",
        eventMode: "fetch",
        properties: { name: "Помощник по закупкам", workPosition: "ИИ-помощник" }
      }
    });
  });
});

describe("BitrixBotClient.pollEvents", () => {
  it("sends the offset only after the first call and maps the response", async () => {
    const { bot, calls } = client([
      { body: { result: { events: [{ eventId: 5, type: "ONIMBOTV2MESSAGEADD", date: "d", data: {} }], nextOffset: 6, hasMore: false } } }
    ]);

    const page = await bot.pollEvents({ botId: 456, offset: 4 });

    expect(calls[0].body).toEqual({ botId: 456, botToken: "tok", limit: 100, offset: 4 });
    expect(page.nextOffset).toBe(6);
    expect(page.hasMore).toBe(false);
    expect(page.events).toHaveLength(1);
  });

  it("omits the offset on the first call", async () => {
    const { bot, calls } = client([{ body: { result: { events: [], nextOffset: 1, hasMore: false } } }]);

    await bot.pollEvents({ botId: 456 });

    expect(calls[0].body).toEqual({ botId: 456, botToken: "tok", limit: 100 });
  });
});

describe("BitrixBotClient.sendMessage", () => {
  it("posts the text to the dialog and returns the message id", async () => {
    const { bot, calls } = client([{ body: { result: { id: 789, uuidMap: {} } } }]);

    const id = await bot.sendMessage({ botId: 456, dialogId: "chat5", text: "Привет" });

    expect(id).toBe(789);
    expect(calls[0].url).toBe(`${WEBHOOK}imbot.v2.Chat.Message.send`);
    expect(calls[0].body).toEqual({ botId: 456, botToken: "tok", dialogId: "chat5", fields: { message: "Привет", urlPreview: false } });
  });
});

describe("BitrixBotClient errors", () => {
  it("throws a BitrixBotError with the Bitrix code and never leaks the webhook url", async () => {
    const { bot } = client([{ status: 400, body: { error: "BOT_NOT_FOUND", error_description: "Bot not found" } }]);

    const error = (await bot.sendMessage({ botId: 1, dialogId: "1", text: "x" }).catch((e: unknown) => e)) as BitrixBotError;

    expect(error).toBeInstanceOf(BitrixBotError);
    expect(error.code).toBe("BOT_NOT_FOUND");
    expect(error.message).toContain("Bot not found");
    expect(error.message).not.toContain("secretcode");
  });

  it("treats a 200 response that carries an error field as an error", async () => {
    const { bot } = client([{ body: { error: "ACCESS_DENIED", error_description: "no" } }]);

    await expect(bot.pollEvents({ botId: 1 })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});

describe("extractUserMessages", () => {
  const events: BotEvent[] = [
    {
      eventId: 10,
      type: "ONIMBOTV2MESSAGEADD",
      date: "d",
      data: {
        chat: { dialogId: "chat5", type: "chat" },
        message: { id: "77", text: " оцени сделку 41293 ", authorId: "12" },
        user: { id: "12" }
      }
    },
    { eventId: 11, type: "ONIMBOTV2JOINCHAT", date: "d", data: {} },
    { eventId: 12, type: "ONIMBOTV2MESSAGEADD", date: "d", data: { chat: { dialogId: "12", type: "private" }, message: { id: 78, text: "", authorId: 12 }, user: { id: 12 } } }
  ];

  it("keeps only non-empty new messages and casts ids to numbers", () => {
    expect(extractUserMessages(events)).toEqual([
      { eventId: 10, dialogId: "chat5", chatType: "chat", chatName: "", entityType: "", dealId: null, isExternal: false, messageId: 77, userId: 12, text: "оцени сделку 41293" }
    ]);
  });

  const groupEvent = (chat: Record<string, unknown>, text = "разбери"): BotEvent => ({
    eventId: 20,
    type: "ONIMBOTV2MESSAGEADD",
    date: "d",
    data: { chat: { dialogId: "chat9", type: "chat", name: "Сделка: [GZ 1] Тест", ...chat }, message: { id: 5, text, authorId: 12 }, user: { id: 12 } }
  });

  it("reads the chat name and the deal id from the entity id of a CRM deal chat", () => {
    const [message] = extractUserMessages([groupEvent({ entityType: "CRM", entityId: "DEAL|48311" })]);

    expect(message).toMatchObject({ chatName: "Сделка: [GZ 1] Тест", entityType: "CRM", dealId: 48311 });
  });

  it("finds the deal id in the chat link when the entity id is empty", () => {
    const [message] = extractUserMessages([groupEvent({ entityId: "", entityLink: { type: "CRM", url: "/crm/deal/details/777/", id: "777" } })]);

    expect(message.dealId).toBe(777);
  });

  it("does not take a contact or company chat for a deal chat", () => {
    const [message] = extractUserMessages([groupEvent({ entityType: "CRM", entityId: "CONTACT|55" })]);

    expect(message.dealId).toBeNull();
  });

  it("marks guests of the portal, bots and dismissed users as external", () => {
    const withUser = (user: Record<string, unknown>): BotEvent => ({
      eventId: 30,
      type: "ONIMBOTV2MESSAGEADD",
      date: "d",
      data: { chat: { dialogId: "5", type: "private" }, message: { id: 9, text: "привет", authorId: 5 }, user: { id: 5, ...user } }
    });

    const flags = extractUserMessages([
      withUser({ extranet: false, bot: false, active: true }),
      withUser({ extranet: true }),
      withUser({ bot: true }),
      withUser({ active: false })
    ]).map((message) => message.isExternal);

    expect(flags).toEqual([false, true, true, true]);
  });

  it("turns a bot mention into plain text so the model sees a clean question", () => {
    const [message] = extractUserMessages([groupEvent({}, "[USER=2379]Помощник по закупкам[/USER] разбери эту сделку")]);

    expect(message.text).toBe("Помощник по закупкам разбери эту сделку");
  });
});
