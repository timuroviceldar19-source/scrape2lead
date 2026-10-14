import { describe, expect, it } from "vitest";
import { handleIncomingMessage, type AssistantDeps } from "../../src/assistant/assistantService.js";
import { DailyUsageLimiter } from "../../src/assistant/usageLimits.js";
import type { IncomingMessage } from "../../src/assistant/bitrixBotClient.js";

const NOW = Date.parse("2026-10-13T07:00:00Z");
const message = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  eventId: 1,
  dialogId: "chat5",
  chatType: "private",
  chatName: "",
  entityType: "",
  dealId: null,
  isExternal: false,
  messageId: 10,
  userId: 2301,
  text: "оцени сделку 48311",
  ...over
});

function setup(over: Partial<AssistantDeps> = {}) {
  const sent: Array<{ dialogId: string; text: string }> = [];
  const asked: Array<{ text: string; userId: number }> = [];
  const deps: AssistantDeps = {
    allowedUserIds: new Set([2301]),
    allowAllEmployees: false,
    limiter: new DailyUsageLimiter({ perUserPerDay: 2, totalPerDay: 10 }),
    ask: async (text, userId) => (asked.push({ text, userId }), { text: "Берём: подходит." }),
    send: async (dialogId, text) => void sent.push({ dialogId, text }),
    now: () => NOW,
    log: () => undefined,
    ...over
  };
  return { deps, sent, asked };
}

describe("handleIncomingMessage", () => {
  it("answers an allowed user and passes the text to the assistant", async () => {
    const { deps, sent, asked } = setup();

    await handleIncomingMessage(message(), deps);

    expect(asked).toEqual([{ text: "оцени сделку 48311", userId: 2301 }]);
    expect(sent).toEqual([{ dialogId: "chat5", text: "Берём: подходит." }]);
  });

  it("tells the assistant which deal a group chat belongs to so that \"this deal\" is understood", async () => {
    const { deps, asked } = setup();

    await handleIncomingMessage(message({ chatType: "chat", chatName: "Сделка: [GZ 1] Тест", entityType: "CRM", dealId: 48311, text: "разбери эту сделку" }), deps);

    expect(asked[0].text).toContain("разбери эту сделку");
    expect(asked[0].text).toContain("48311");
    expect(asked[0].text).toContain("Сделка: [GZ 1] Тест");
  });

  it("passes the chat name when the group chat has no known deal, so the assistant can search by the title", async () => {
    const { deps, asked } = setup();

    await handleIncomingMessage(message({ chatType: "chat", chatName: "Сделка: [GZ 88052990] Компьютер", text: "найди контакты" }), deps);

    expect(asked[0].text).toContain("[GZ 88052990]");
    expect(asked[0].text).toContain("find_deals");
    expect(asked[0].text).toContain("найди контакты");
  });

  it("logs only the chat kind and never the text of the message", async () => {
    const lines: string[] = [];
    const { deps } = setup({ log: (line) => void lines.push(line) });

    await handleIncomingMessage(message({ chatType: "chat", entityType: "CRM", dealId: 5, text: "секретный текст" }), deps);

    expect(lines.join("\n")).toContain("CRM");
    expect(lines.join("\n")).not.toContain("секретный");
  });

  it("refuses a user who is not on the list and never calls the assistant", async () => {
    const { deps, sent, asked } = setup();

    await handleIncomingMessage(message({ userId: 999 }), deps);

    expect(asked).toHaveLength(0);
    expect(sent[0].text).toMatch(/нет доступа/i);
  });

  it("answers any employee when the bot is open to everyone", async () => {
    const { deps, sent, asked } = setup({ allowAllEmployees: true });

    await handleIncomingMessage(message({ userId: 999 }), deps);

    expect(asked).toEqual([{ text: "оцени сделку 48311", userId: 999 }]);
    expect(sent[0].text).toBe("Берём: подходит.");
  });

  it("still refuses a guest or a bot when the bot is open to everyone", async () => {
    const { deps, sent, asked } = setup({ allowAllEmployees: true });

    await handleIncomingMessage(message({ userId: 999, isExternal: true }), deps);

    expect(asked).toHaveLength(0);
    expect(sent[0].text).toMatch(/нет доступа/i);
  });

  it("keeps the daily limits for everyone when the bot is open", async () => {
    const { deps, sent, asked } = setup({ allowAllEmployees: true });

    for (const messageId of [1, 2, 3]) await handleIncomingMessage(message({ userId: 999, messageId }), deps);

    expect(asked).toHaveLength(2);
    expect(sent[2].text).toMatch(/лимит/i);
  });

  it("refuses with a clear message when the personal limit is used up", async () => {
    const { deps, sent, asked } = setup();

    await handleIncomingMessage(message(), deps);
    await handleIncomingMessage(message({ messageId: 11 }), deps);
    await handleIncomingMessage(message({ messageId: 12 }), deps);

    expect(asked).toHaveLength(2);
    expect(sent[2].text).toMatch(/лимит/i);
  });

  it("says so when the shared daily cap is reached", async () => {
    const { deps, sent } = setup({ limiter: new DailyUsageLimiter({ perUserPerDay: 5, totalPerDay: 0 }) });

    await handleIncomingMessage(message(), deps);

    expect(sent[0].text).toMatch(/общий.*лимит/i);
  });

  it("replies with a friendly error and no internals when the assistant fails", async () => {
    const { deps, sent } = setup({
      ask: async () => {
        throw new Error("401 invalid x-api-key sk-ant-secret");
      }
    });

    await handleIncomingMessage(message(), deps);

    expect(sent[0].text).toMatch(/не получилось/i);
    expect(sent[0].text).not.toContain("sk-ant");
  });

  it("keeps a very long answer within the Bitrix message limit", async () => {
    const { deps, sent } = setup({ ask: async () => ({ text: "я".repeat(30_000) }) });

    await handleIncomingMessage(message(), deps);

    expect(sent[0].text.length).toBeLessThanOrEqual(19_000);
  });
});
