import { afterEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";
import { BitrixClient } from "../../src/bitrix/client.js";
import { formatSafeErrorStatus } from "../../src/bitrix/salesPult/safeLog.js";
import { main, runSalesPult, type PultConfig } from "../../scripts/sales-pult.mjs";

// Все имена, компании, суммы и идентификаторы в тесте полностью вымышленные.
const FICTIONAL_WEBHOOK = "https://example.bitrix.test/rest/9990/fake-secret-token";
const FICTIONAL_CHAT_ID = "chat99001";
const FICTIONAL_PULT_URL = "https://example-pult.test";
const FICTIONAL_NOW_ISO = "2026-10-28T04:00:00.000Z"; // среда, 09:00 Алматы (рабочий день)

const MGR_1 = { id: "9101", name: "Арман Тестовый" };
const MGR_2 = { id: "9102", name: "Дана Вымышленная" };
const COMPANY_1 = "Северный Ветер Логистик";
const DEAL_TITLE_1 = `ТОО "${COMPANY_1}" — Учебные стенды`;
const DEAL_TITLE_2 = 'АО "Выдуманный Центр" — Лабораторный набор';
const COMMENT_1 = "Перезвонить Ильясу из Северного Ветра по договору";
const AMOUNT_1 = 12_345_678;
const AMOUNT_2 = 7_654_321;

const FORBIDDEN_SNIPPETS = [
  "Арман",
  "Тестовый",
  "Дана",
  "Вымышленная",
  MGR_1.id,
  MGR_2.id,
  COMPANY_1,
  "Учебные стенды",
  "Выдуманный Центр",
  "Лабораторный набор",
  "Перезвонить Ильясу",
  "12 345 678",
  "12345678",
  "7 654 321",
  "7654321",
  "#автоотчёт",
  "План на день",
  "Отчёт за день",
  "Топ-5 задач",
  "Договоров заключено",
  "Нормативы на день",
  "fake-secret-token"
];

function createFictionalConfig(): PultConfig {
  return {
    portal: "https://example.bitrix.test",
    timezone: "Asia/Almaty",
    timezoneOffsetHours: 5,
    chatDialogId: FICTIONAL_CHAT_ID,
    pultUrl: FICTIONAL_PULT_URL,
    proposalsTracked: true,
    maxOverdueDays: 30,
    topTaskCategories: [9],
    holidays: [],
    targets: {
      daily: { calls: 15, proposals: 3, contracts: 1 },
      weekly: { calls: 75, proposals: 15, contracts: 5 },
      monthly: { calls: 300, proposals: 60, contracts: 20 }
    },
    stages: {
      proposals: ["C9:UC_PROPOSAL"],
      contracts: ["C9:WON"]
    },
    groups: [
      {
        id: "sales",
        name: "Вымышленный отдел",
        trackedMetrics: ["calls", "proposals", "contracts"],
        managers: [MGR_1, MGR_2]
      }
    ]
  };
}

interface MockBitrixOptions {
  chatMessages?: Array<{ id: number; text: string }>;
  onGetMessages?: () => Response | Promise<Response>;
  onSendMessage?: (body: Record<string, unknown>) => Response | Promise<Response>;
  failActivitiesForManagerId?: string;
  failBatchWithSensitiveText?: boolean;
}

function createFakeBitrixFetch(opts: MockBitrixOptions = {}) {
  const sentMessages: Array<{ dialogId: string; message: string; urlPreview?: string }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop()?.replace(/\.json$/, "") ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === "im.dialog.messages.get") {
      if (opts.onGetMessages) {
        return opts.onGetMessages();
      }
      return jsonResponse({ result: { messages: opts.chatMessages ?? [] } });
    }

    if (method === "im.user.get") {
      const id = String(body.ID ?? "");
      if (id === MGR_1.id) return jsonResponse({ result: { name: MGR_1.name, active: true } });
      if (id === MGR_2.id) return jsonResponse({ result: { name: MGR_2.name, active: true } });
      return jsonResponse({ result: { name: `Неизвестный ${id}`, active: true } });
    }

    if (method === "crm.deal.list") {
      return jsonResponse({
        result: [
          {
            ID: "5001",
            TITLE: DEAL_TITLE_1,
            ASSIGNED_BY_ID: MGR_1.id,
            OPPORTUNITY: String(AMOUNT_1),
            CATEGORY_ID: "9",
            STAGE_ID: "C9:NEW",
            STAGE_SEMANTIC_ID: "P",
            CLOSED: "N",
            UF_CRM_PLAN_ID: "88001234",
            DATE_CREATE: "2026-10-25T10:00:00+05:00"
          },
          {
            ID: "5002",
            TITLE: DEAL_TITLE_2,
            ASSIGNED_BY_ID: MGR_2.id,
            OPPORTUNITY: String(AMOUNT_2),
            CATEGORY_ID: "9",
            STAGE_ID: "C9:WON",
            STAGE_SEMANTIC_ID: "S",
            CLOSED: "Y",
            UF_CRM_PLAN_ID: "88005678",
            CLOSEDATE: "2026-10-28T11:00:00+05:00",
            DATE_CREATE: "2026-10-20T10:00:00+05:00"
          }
        ]
      });
    }

    if (method === "batch") {
      if (opts.failBatchWithSensitiveText) {
        return jsonResponse(
          {
            error: "INTERNAL_ERROR",
            error_description: `Batch failure with ${MGR_1.name} and ${COMPANY_1} sum ${AMOUNT_1}`
          },
          500
        );
      }
      const cmd = (body.cmd ?? {}) as Record<string, string>;
      const result: Record<string, unknown> = {};
      const resultError: Record<string, unknown> = {};

      for (const [key, rawCmd] of Object.entries(cmd)) {
        const isFirstPage = !rawCmd.includes("start=") || rawCmd.includes("start=0");
        if (!isFirstPage) {
          result[key] = rawCmd.startsWith("crm.stagehistory.list") ? { items: [] } : [];
          continue;
        }
        if (rawCmd.startsWith("crm.stagehistory.list")) {
          if (rawCmd.includes("C9%3AWON") || rawCmd.includes("C9:WON")) {
            result[key] = {
              items: [
                { ID: "1", OWNER_ID: "5002", STAGE_ID: "C9:WON", CREATED_TIME: "2026-10-28T11:00:00+05:00" }
              ]
            };
          } else {
            result[key] = { items: [] };
          }
        } else if (rawCmd.startsWith("crm.deal.list")) {
          result[key] = [];
        } else if (rawCmd.startsWith("voximplant.statistic.get")) {
          result[key] = [
            {
              ID: "701",
              PORTAL_USER_ID: MGR_1.id,
              CALL_FAILED_CODE: "200",
              CALL_DURATION: "65",
              CALL_START_DATE: "2026-10-28T09:30:00+05:00"
            },
            {
              ID: "702",
              PORTAL_USER_ID: MGR_2.id,
              CALL_FAILED_CODE: "200",
              CALL_DURATION: "90",
              CALL_START_DATE: "2026-10-28T09:45:00+05:00"
            }
          ];
        } else if (rawCmd.startsWith("crm.activity.list") && rawCmd.includes("RESPONSIBLE_ID")) {
          const isMgr1 = rawCmd.includes(`RESPONSIBLE_ID%5D=${MGR_1.id}`) || rawCmd.includes(`RESPONSIBLE_ID]=${MGR_1.id}`);
          const isMgr2 = rawCmd.includes(`RESPONSIBLE_ID%5D=${MGR_2.id}`) || rawCmd.includes(`RESPONSIBLE_ID]=${MGR_2.id}`);
          if (opts.failActivitiesForManagerId && rawCmd.includes(opts.failActivitiesForManagerId)) {
            resultError[key] = {
              error: "ACTIVITY_FAIL",
              error_description: `Task fail for ${MGR_1.name} ${DEAL_TITLE_1} ${AMOUNT_1}`
            };
            continue;
          }
          if (isMgr1) {
            result[key] = [
              {
                ID: "9001",
                OWNER_ID: "5001",
                OWNER_TYPE_ID: "2",
                RESPONSIBLE_ID: MGR_1.id,
                SUBJECT: "Согласовать спецификацию",
                CREATED: "2026-10-26T10:00:00+05:00",
                PROVIDER_ID: "CRM_TODO",
                DEADLINE: "2026-10-28T15:00:00+05:00",
                COMPLETED: "N"
              }
            ];
          } else if (isMgr2) {
            result[key] = [];
          } else {
            result[key] = [];
          }
        } else if (rawCmd.startsWith("crm.timeline.comment.list")) {
          if (rawCmd.includes("5001")) {
            result[key] = [
              {
                ID: "3001",
                COMMENT: COMMENT_1,
                AUTHOR_ID: MGR_1.id,
                CREATED: "2026-10-27T12:00:00+05:00"
              }
            ];
          } else {
            result[key] = [];
          }
        } else {
          result[key] = [];
        }
      }

      return jsonResponse({ result: { result, result_error: resultError } });
    }

    if (method === "im.message.add") {
      if (opts.onSendMessage) {
        return opts.onSendMessage(body);
      }
      sentMessages.push({
        dialogId: String(body.DIALOG_ID ?? ""),
        message: String(body.MESSAGE ?? ""),
        urlPreview: body.URL_PREVIEW ? String(body.URL_PREVIEW) : undefined
      });
      return jsonResponse({ result: sentMessages.length });
    }

    return jsonResponse({ result: [] });
  }) as typeof fetch;

  return { fetchImpl, sentMessages };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; combined: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(`${format(...args)}\n`);
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderrChunks.push(`${format(...args)}\n`);
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrChunks.push(`${format(...args)}\n`);
  });
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);

  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  return { stdout, stderr, combined: `${stdout}\n${stderr}` };
}

function expectNoSensitiveLeaks(text: string): void {
  for (const snippet of FORBIDDEN_SNIPPETS) {
    expect(text).not.toContain(snippet);
  }
}

describe("Sales Pult public logs redaction (morning / evening / dry-run / delivery errors)", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("hides names, sums and report text in stdout/stderr when chat sending is disabled (no --execute) in morning mode", async () => {
    const { fetchImpl, sentMessages } = createFakeBitrixFetch();
    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "morning"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(sentMessages).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
    expect(out.stdout).toContain("[DRY-RUN]");
    expect(out.stdout).toContain("всего=2");
    expect(out.stdout).toContain("dry_run=2");
    expect(out.stdout).toContain("отправлено=0");
    expectNoSensitiveLeaks(out.combined);
  });

  it("treats explicit --dry-run as disabled even if --execute is also passed (evening mode)", async () => {
    const { fetchImpl, sentMessages } = createFakeBitrixFetch();
    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "evening", "--execute", "--dry-run"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(sentMessages).toHaveLength(0);
    expect(out.stdout).toContain("execute: false");
    expect(out.stdout).toContain("dry_run=2");
    expectNoSensitiveLeaks(out.combined);
  });

  it("sends full morning reports to the configured channel while keeping stdout/stderr anonymized", async () => {
    const { fetchImpl, sentMessages } = createFakeBitrixFetch();
    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "morning", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(process.exitCode).toBeUndefined();
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].dialogId).toBe(FICTIONAL_CHAT_ID);
    expect(sentMessages[0].urlPreview).toBe("N");
    expect(sentMessages[0].message).toContain(`#автоотчёт 2026-10-28 утро ${MGR_1.id}`);
    expect(sentMessages[0].message).toContain(MGR_1.name);
    expect(sentMessages[0].message).toContain(DEAL_TITLE_1);
    expect(sentMessages[0].message).toContain("12 345 678 ₸");
    expect(sentMessages[0].message).toContain(COMMENT_1);
    expect(sentMessages[0].message).toContain(FICTIONAL_PULT_URL);

    expect(sentMessages[1].dialogId).toBe(FICTIONAL_CHAT_ID);
    expect(sentMessages[1].message).toContain(`#автоотчёт 2026-10-28 утро ${MGR_2.id}`);
    expect(sentMessages[1].message).toContain(MGR_2.name);

    expect(out.stdout).toContain("отправлено=2");
    expect(out.stdout).toContain("ошибок_доставки=0");
    expectNoSensitiveLeaks(out.combined);
  });

  it("sends full evening reports to the configured channel while keeping stdout/stderr anonymized", async () => {
    const { fetchImpl, sentMessages } = createFakeBitrixFetch();
    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "evening", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(process.exitCode).toBeUndefined();
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].message).toContain(`#автоотчёт 2026-10-28 вечер ${MGR_1.id}`);
    expect(sentMessages[0].message).toContain(MGR_1.name);
    expect(sentMessages[0].message).toContain("Звонки: 15/1");

    expect(sentMessages[1].message).toContain(`#автоотчёт 2026-10-28 вечер ${MGR_2.id}`);
    expect(sentMessages[1].message).toContain(MGR_2.name);
    expect(sentMessages[1].message).toContain("7 654 321 ₸");
    expect(sentMessages[1].message).toContain(FICTIONAL_PULT_URL);

    expect(out.stdout).toContain("отправлено=2");
    expectNoSensitiveLeaks(out.combined);
  });

  it("reports delivery error status without leaking echoed payload, names, sums, or response body", async () => {
    const { fetchImpl } = createFakeBitrixFetch({
      onSendMessage: (body) => {
        const echoed = String(body.MESSAGE ?? "");
        if (echoed.includes(MGR_1.id)) {
          return jsonResponse(
            {
              error: "DELIVERY_REJECTED",
              error_description: `Cannot deliver report: ${echoed}`
            },
            500
          );
        }
        return new Response(
          `<html>Bad Gateway for ${MGR_2.name} ${COMPANY_1} ${AMOUNT_2} ${echoed}</html>`,
          { status: 502, headers: { "content-type": "text/html" } }
        );
      }
    });

    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "morning", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(process.exitCode).toBe(1);
    expect(out.stderr).toContain("HTTP 500");
    expect(out.stderr).toContain("code=DELIVERY_REJECTED");
    expect(out.stderr).toContain("HTTP 502");
    expect(out.stderr).toContain("[ОШИБКА ДОСТАВКИ]");
    expect(out.stdout).toContain("ошибок_доставки=2");
    expectNoSensitiveLeaks(out.combined);
  });

  it("handles idempotency skips and task-loading errors without leaking names, IDs, or error payloads", async () => {
    const { fetchImpl, sentMessages } = createFakeBitrixFetch({
      chatMessages: [{ id: 10, text: `#автоотчёт 2026-10-28 утро ${MGR_1.id}\n${MGR_1.name} ${AMOUNT_1}` }],
      failActivitiesForManagerId: MGR_2.id
    });

    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "morning", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(process.exitCode).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message).toContain(`#автоотчёт 2026-10-28 утро ${MGR_2.id}`);
    expect(out.stdout).toContain("пропущено_идемпотентно=1");
    expect(out.stdout).toContain("отправлено=1");
    expect(out.stderr).toContain("затронуто менеджеров 1");
    expectNoSensitiveLeaks(out.combined);
  });

  it("sanitizes fatal errors in main() so Bitrix error bodies do not leak to stderr", async () => {
    const { fetchImpl } = createFakeBitrixFetch({ failBatchWithSensitiveText: true });
    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const out = await captureOutput(() =>
      main(["--mode", "morning", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(out.stderr).toContain("Sales Pult Error:");
    expect(out.stderr).toContain("HTTP 500");
    expect(out.stderr).toContain("code=INTERNAL_ERROR");
    expectNoSensitiveLeaks(out.combined);
  });

  it("handles secondary chat re-read failure after delivery error without leaking sensitive error details", async () => {
    let getMessagesCalls = 0;
    const { fetchImpl } = createFakeBitrixFetch({
      onGetMessages: () => {
        getMessagesCalls++;
        if (getMessagesCalls === 1) {
          return jsonResponse({ result: { messages: [] } });
        }
        return jsonResponse(
          {
            error: "READ_FAIL",
            error_description: `Cannot read chat for ${MGR_1.name} ${COMPANY_1} ${AMOUNT_1}`
          },
          503
        );
      },
      onSendMessage: () =>
        jsonResponse(
          {
            error: "TIMEOUT",
            error_description: `Send timeout ${MGR_2.name} ${AMOUNT_2}`
          },
          504
        )
    });

    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "evening", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(process.exitCode).toBe(1);
    expect(out.stderr).toContain("HTTP 504");
    expect(out.stderr).toContain("HTTP 503");
    expect(out.stdout).toContain("ошибок_доставки=2");
    expectNoSensitiveLeaks(out.combined);
  });

  it("verifies delivery via chat re-read after transient send error without leaking sensitive text", async () => {
    const deliveredAfterError: Array<{ id: number; text: string }> = [];
    const { fetchImpl } = createFakeBitrixFetch({
      onGetMessages: () => jsonResponse({ result: { messages: deliveredAfterError } }),
      onSendMessage: (body) => {
        const msg = String(body.MESSAGE ?? "");
        deliveredAfterError.push({ id: deliveredAfterError.length + 100, text: msg });
        return jsonResponse(
          {
            error: "GATEWAY_TIMEOUT",
            error_description: `Timed out after accepting ${msg}`
          },
          504
        );
      }
    });

    const rawClient = new BitrixClient(FICTIONAL_WEBHOOK, {
      fetchImpl,
      requestDelayMs: 0,
      retryBaseDelayMs: 0
    });

    const out = await captureOutput(() =>
      runSalesPult(["--mode", "morning", "--execute"], {
        config: createFictionalConfig(),
        rawClient,
        webhookUrl: FICTIONAL_WEBHOOK,
        nowIso: FICTIONAL_NOW_ISO,
        skipUpdates: true
      })
    );

    expect(process.exitCode).toBeUndefined();
    expect(deliveredAfterError).toHaveLength(2);
    expect(out.stderr).toContain("HTTP 504");
    expect(out.stderr).toContain("code=GATEWAY_TIMEOUT");
    expect(out.stdout).toContain("подтверждено_после_сбоя=2");
    expect(out.stdout).toContain("ошибок_доставки=0");
    expectNoSensitiveLeaks(out.combined);
  });

  it("formatSafeErrorStatus drops sensitive messages, Cyrillic codes, and numeric-only codes", () => {
    const errWithMessage = Object.assign(new Error("Арман Тестовый 12 345 678 ₸"), {
      status: 502,
      code: "GATEWAY_ERROR"
    });
    expect(formatSafeErrorStatus(errWithMessage)).toBe("Error, HTTP 502, code=GATEWAY_ERROR");

    const errWithUnsafeCode = Object.assign(new Error("secret body"), {
      status: 400,
      code: "12345678"
    });
    expect(formatSafeErrorStatus(errWithUnsafeCode)).toBe("Error, HTTP 400");

    expect(formatSafeErrorStatus("Арман Тестовый 12 345 678")).toBe("Error");
  });
});
