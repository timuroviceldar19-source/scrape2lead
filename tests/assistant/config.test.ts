import { describe, expect, it } from "vitest";
import { loadAssistantConfig } from "../../src/assistant/config.js";

const BASE_ENV = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  BITRIX_CRM_WEBHOOK_URL: "https://x.bitrix24.kz/rest/1/crm/",
  GOSZAKUP_TOKEN: "gz-token"
};

describe("loadAssistantConfig", () => {
  it("applies defaults: Haiku 5.5, small daily limits, nobody allowed until configured", () => {
    const config = loadAssistantConfig(BASE_ENV);

    expect(config.model).toBe("claude-haiku-5-5");
    expect(config.perUserPerDay).toBe(30);
    expect(config.totalPerDay).toBe(200);
    expect(config.allowedUserIds).toEqual([]);
    expect(config.allowAllEmployees).toBe(false);
    expect(config.pollIntervalMs).toBe(3000);
    expect(config.bot).toBeNull();
  });

  it("reads the allowed users, limits and model overrides", () => {
    const config = loadAssistantConfig({
      ...BASE_ENV,
      ASSISTANT_MODEL: "claude-sonnet-5-5",
      ASSISTANT_ALLOWED_USER_IDS: "2301, 1751 ,,x",
      ASSISTANT_DAILY_LIMIT_PER_USER: "5",
      ASSISTANT_DAILY_LIMIT_TOTAL: "50"
    });

    expect(config.model).toBe("claude-sonnet-5-5");
    expect(config.allowedUserIds).toEqual([2301, 1751]);
    expect(config.perUserPerDay).toBe(5);
    expect(config.totalPerDay).toBe(50);
  });

  it("opens the bot to every employee when the allowed list is a star", () => {
    const config = loadAssistantConfig({ ...BASE_ENV, ASSISTANT_ALLOWED_USER_IDS: "*" });

    expect(config.allowAllEmployees).toBe(true);
    expect(config.allowedUserIds).toEqual([]);
  });

  it("keeps the explicit ids next to the star", () => {
    const config = loadAssistantConfig({ ...BASE_ENV, ASSISTANT_ALLOWED_USER_IDS: "2301, *" });

    expect(config.allowAllEmployees).toBe(true);
    expect(config.allowedUserIds).toEqual([2301]);
  });

  it("names the missing variable without printing any value", () => {
    expect(() => loadAssistantConfig({ ...BASE_ENV, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadAssistantConfig({ ...BASE_ENV, GOSZAKUP_TOKEN: undefined })).toThrow(/GOSZAKUP_TOKEN/);
  });

  it("returns the bot settings only when the bot webhook and token are present", () => {
    const config = loadAssistantConfig({
      ...BASE_ENV,
      BITRIX_BOT_WEBHOOK_URL: "https://x.bitrix24.kz/rest/1/bot/",
      BITRIX_BOT_TOKEN: "tok",
      BITRIX_BOT_ID: "456"
    });

    expect(config.bot).toEqual({ webhookUrl: "https://x.bitrix24.kz/rest/1/bot/", token: "tok", botId: 456 });
  });

  it("rejects a bot token longer than Bitrix allows", () => {
    expect(() =>
      loadAssistantConfig({ ...BASE_ENV, BITRIX_BOT_WEBHOOK_URL: "https://x.bitrix24.kz/rest/1/bot/", BITRIX_BOT_TOKEN: "t".repeat(41) })
    ).toThrow(/BITRIX_BOT_TOKEN/);
  });
});
