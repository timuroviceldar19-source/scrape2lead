import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BitrixClient } from "../../src/bitrix/client.js";
import { runSalesPult, type PultConfig } from "../../scripts/sales-pult.mjs";
import { financeWorkbookBuffer } from "../fixtures/sales-pult/financeWorkbook.js";
import type { CompetitorsView } from "../../src/kz/competitors/types.js";

// Утренний режим: дайджест директору собирается, но не отправляется и не печатается в публичный лог.
// Все имена, суммы, лоты и адреса вымышленные.
const WEBHOOK = "https://example.bitrix.test/rest/9990/fake-secret-token";
const CHAT_ID = "chat99001";
const PULT_URL = "https://example-pult.test";
const NOW_ISO = "2026-10-28T04:00:00.000Z"; // среда, 09:00 Алматы
const MGR_1 = { id: "9101", name: "Арман Тестовый" };
const MGR_2 = { id: "9102", name: "Дана Вымышленная" };
const LOT_ITEM = "Интерактивная панель Выдуманная";
const LOT_SUM = 61_234_567;

// Строки, которых не должно быть в stdout/stderr: текст дайджеста, суммы, лот, имена.
const FORBIDDEN = [
  "#дайджест", "Утренний пульс", "Кассовый разрыв", "Долги старше", "Подать сегодня", "не хватает",
  "61 234 567", "61234567", "61,2 млн", LOT_ITEM, "Арман", "Дана", "fake-secret-token"
];

function config(): PultConfig {
  return {
    portal: "https://example.bitrix.test", timezone: "Asia/Almaty", timezoneOffsetHours: 5, chatDialogId: CHAT_ID,
    pultUrl: PULT_URL, proposalsTracked: true, maxOverdueDays: 30, topTaskCategories: [9], holidays: [],
    targets: {
      daily: { calls: 15, proposals: 3, contracts: 1 }, weekly: { calls: 75, proposals: 15, contracts: 5 },
      monthly: { calls: 300, proposals: 60, contracts: 20 }
    },
    stages: { proposals: ["C9:UC_PROPOSAL"], contracts: ["C9:WON"] },
    groups: [{ id: "sales", name: "Вымышленный отдел", trackedMetrics: ["calls", "proposals", "contracts"], managers: [MGR_1, MGR_2] }]
  };
}

const LOT_DEAL = {
  ID: "4301", TITLE: `GZ 777-ЗЦП1 — ${LOT_ITEM}`, STAGE_ID: "C43:NEW", STAGE_SEMANTIC_ID: "P", CLOSED: "N",
  ASSIGNED_BY_ID: MGR_1.id, OPPORTUNITY: String(LOT_SUM), ORIGIN_ID: "gz-lot:777-ЗЦП1", UF_CRM_6627AEBD54B8D: LOT_ITEM,
  UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)",
  COMMENTS: "Приём заявок: 2026-10-20 10:00 — 2026-10-28 11:00 (время Алматы)\nЗаказчик: Школа Вымышленная (БИН 000000000001)"
};

function fakeBitrix(opts: { failRadar?: boolean } = {}) {
  const sent: string[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop()?.replace(/\.json$/, "") ?? "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "im.dialog.messages.get") return json({ result: { messages: [] } });
    if (method === "im.user.get") {
      const id = String(body.ID ?? "");
      const who = [MGR_1, MGR_2].find((m) => m.id === id);
      return json({ result: { name: who?.name ?? `Неизвестный ${id}`, active: true } });
    }
    if (method === "im.message.add") { sent.push(String(body.MESSAGE ?? "")); return json({ result: sent.length }); }
    if (method === "batch") {
      const result: Record<string, unknown> = {};
      const resultError: Record<string, unknown> = {};
      for (const [key, cmd] of Object.entries((body.cmd ?? {}) as Record<string, string>)) {
        const firstPage = !cmd.includes("start=") || /start=0(?!\d)/.test(cmd);
        if (cmd.startsWith("crm.stagehistory.list")) result[key] = { items: [] };
        else if (cmd.startsWith("crm.deal.list") && cmd.includes("scrape2lead-gz-lots") && opts.failRadar) resultError[key] = { error: "QUERY_LIMIT_EXCEEDED", error_description: LOT_ITEM };
        else if (cmd.startsWith("crm.deal.list") && cmd.includes("scrape2lead-gz-lots") && firstPage) result[key] = [LOT_DEAL];
        else result[key] = [];
      }
      return json({ result: { result, result_error: resultError } });
    }
    return json({ result: [] });
  }) as typeof fetch;
  return { client: new BitrixClient(WEBHOOK, { fetchImpl, requestDelayMs: 0, retryBaseDelayMs: 0 }), sent };
}

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; combined: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(`${format(...a)}\n`); }),
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { err.push(`${format(...a)}\n`); }),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(`${format(...a)}\n`); }),
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write)
  ];
  try { await fn(); } finally { spies.forEach((s) => s.mockRestore()); }
  return { stdout: out.join(""), combined: `${out.join("")}\n${err.join("")}` };
}

let financeFile = "";
beforeAll(async () => {
  financeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pulse-fin-")), "Ежедневный отчёт тест.xlsx");
  fs.writeFileSync(financeFile, await financeWorkbookBuffer({ stockSheets: true }));
});

describe("утренний режим: дайджест директору (dry-run)", () => {
  const savedCi = process.env.CI;
  afterEach(() => {
    process.exitCode = undefined;
    if (savedCi === undefined) delete process.env.CI; else process.env.CI = savedCi;
    vi.restoreAllMocks();
  });

  it("собирает дайджест, в лог — только число пунктов и длина; горящий лот — в отчёт своего менеджера", async () => {
    const { client, sent } = fakeBitrix();
    const out = await capture(() => runSalesPult(["--mode", "morning", "--execute", "--finance-file", financeFile], {
      config: config(), rawClient: client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true
    }));
    expect(out.stdout).toMatch(/\[DRY-RUN\] Дайджест директору сформирован \(пунктов \d+, длина \d+ симв\.\)/);
    expect(sent).toHaveLength(2);
    expect(sent.some((m) => m.startsWith("#дайджест"))).toBe(false);
    expect(sent[0]).toContain(`#автоотчёт 2026-10-28 утро ${MGR_1.id}`);
    expect(sent[0]).toContain(`🔥 Срок подачи сегодня: [777-ЗЦП1] ${LOT_ITEM} — 61 234 567 ₸, до 11:00`);
    expect(sent[1]).not.toContain("🔥 Срок подачи");
    expect(process.exitCode).toBeUndefined();
  });

  it("в CI текст дайджеста не печатается даже с --print-digest", async () => {
    process.env.CI = "true";
    const { client } = fakeBitrix();
    const out = await capture(() => runSalesPult(["--mode", "morning", "--finance-file", financeFile, "--print-digest"], {
      config: config(), rawClient: client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true
    }));
    const match = /\(пунктов (\d+), длина (\d+) симв\.\)/.exec(out.stdout);
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(2);
    for (const snippet of FORBIDDEN) expect(out.combined, snippet).not.toContain(snippet);
  });

  it("локально --print-digest печатает текст в stdout", async () => {
    delete process.env.CI;
    const { client } = fakeBitrix();
    const out = await capture(() => runSalesPult(["--mode", "morning", "--finance-file", financeFile, "--print-digest"], {
      config: config(), rawClient: client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true
    }));
    expect(out.stdout).toContain("#дайджест 2026-10-28 директор");
    expect(out.stdout).toContain("🔴 Подать сегодня · ИП: 1 лот · 61,2 млн ₸");
    expect(out.stdout).toContain("🔴 Кассовый разрыв");
  });

  it("свежие отклонения ниже цены победителя попадают в дайджест, а номера лотов — нет в лог; сбой «Конкурентов» дайджест не отменяет", async () => {
    delete process.env.CI;
    const rejection = {
      annoId: "A-1", lotNumber: "LOSS-LOT-31337", date: "2026-10-20", endDate: "2026-10-27", ourCompany: "ТОО «Демо Ф3»",
      ourBin: "900000000001", customerName: "Школа Тест", kind: "Интерактивные панели", status: "Завершена",
      rejectionShort: "Не предоставлено письмо производителя", rejectionDetail: "", ourPrice: 4_000_000, ourUnitPrice: 4_000_000,
      winnerName: "ТОО «Соперник»", winnerBin: "900000000101", winnerPrice: 4_500_000, winnerUnitPrice: 4_500_000,
      cheaperThanWinner: true, cheaperByPct: 11.1, url: "https://example.invalid/lot"
    };
    const competitors = {
      asOf: "2026-10-28", months: [], kt: null,
      ip: { group: "ИП", competitors: [], ourRejections: [rejection] }
    } as unknown as CompetitorsView;
    const calls: string[] = [];
    const { client } = fakeBitrix();
    const out = await capture(() => runSalesPult(["--mode", "morning", "--finance-file", financeFile, "--print-digest"], {
      config: config(), rawClient: client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true,
      loadCompetitors: (day) => { calls.push(day); return competitors; }
    }));
    expect(calls).toEqual(["2026-10-28"]);
    expect(out.stdout).toContain("Отклонены при цене ниже победителя");

    process.env.CI = "true";
    const ci = await capture(() => runSalesPult(["--mode", "morning", "--finance-file", financeFile], {
      config: config(), rawClient: fakeBitrix().client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true,
      loadCompetitors: () => competitors
    }));
    expect(ci.combined).not.toContain("LOSS-LOT-31337");

    const broken = await capture(() => runSalesPult(["--mode", "morning"], {
      config: config(), rawClient: fakeBitrix().client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true,
      loadCompetitors: () => { throw new Error("db locked"); }
    }));
    expect(broken.stdout).toMatch(/\[DRY-RUN\] Дайджест директору сформирован/);
    expect(process.exitCode).toBeUndefined();
  });

  it("радар упал, финансов нет — утренний режим не падает, дайджест всё равно собран", async () => {
    process.env.CI = "true";
    const { client } = fakeBitrix({ failRadar: true });
    const out = await capture(() => runSalesPult(["--mode", "morning"], {
      config: config(), rawClient: client, webhookUrl: WEBHOOK, nowIso: NOW_ISO, skipUpdates: true
    }));
    expect(out.stdout).toContain("[DRY-RUN] Дайджест директору сформирован (пунктов 0,");
    expect(out.stdout).toContain("dry_run=2");
    expect(process.exitCode).toBeUndefined();
    for (const snippet of FORBIDDEN) expect(out.combined, snippet).not.toContain(snippet);
  });
});
