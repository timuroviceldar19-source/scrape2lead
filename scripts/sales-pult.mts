import "dotenv/config";
import { attachRegisterContracts } from "../src/bitrix/salesPult/contracts.js";
import { loadClosedMonths } from "../src/bitrix/salesPult/months.js";
import { formatSafeErrorStatus } from "../src/bitrix/salesPult/safeLog.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BitrixClient } from "../src/bitrix/client.js";
import { ReadOnlyBitrixClient } from "../src/bitrix/reporting/readOnlyClient.js";
import {
  collectPultData,
  extractWebhookUserId,
  type PultCollectedData
} from "../src/bitrix/salesPult/collect.js";
import {
  toAlmatyDate,
  formatAlmatyTime,
  getMonthDates,
  getWorkweekDates,
  getPultCollectionStartDate,
  getDateRange,
  calculateDailyMetrics,
  calculateRollups,
  type DailyActivityMetrics,
  type ManagerRollups,
  type TopTask
} from "../src/bitrix/salesPult/metrics.js";
import {
  buildMorningReport,
  buildEveningReport,
  buildDirectorDigest,
  isReportAlreadySent,
  parseManualReport,
  formatMoney,
  type ParsedManualReport
} from "../src/bitrix/salesPult/chatReport.js";
import {
  renderPultHtml,
  renderRegisterHtml,
  renderFinanceHtml,
  type SalesPultPayload,
  type RegisterPagePayload,
  type FinancePagePayload,
  type PultGroupView,
  type DayDynamic
} from "../src/bitrix/salesPult/site.js";
import { loadRegisterView } from "../src/bitrix/salesPult/register/load.js";
import { loadFinanceView } from "../src/bitrix/salesPult/finance/load.js";
import { buildStockAvailability, buildStockDemand, summarizeStagnantDemand, withStockHints } from "../src/bitrix/salesPult/stock/availability.js";
import { updateMarketWindow } from "../src/kz/market/updateWindow.js";
import { loadMarketView } from "../src/kz/market/load.js";
import { buildAllMarketMonthContracts, filterMarketUnitsForView } from "../src/kz/market/aggregate.js";
import { loadMarketConfig } from "../src/kz/market/config.js";
import { loadEducationVerdicts } from "../src/kz/market/educationVerdicts.js";
import type { MarketConfig } from "../src/kz/market/types.js";
import type { CompetitorsView } from "../src/kz/competitors/types.js";
import { backfillCompetitors } from "../src/kz/competitors/collector.js";
import { updateCompetitorsWindow, loadCompetitorsView, resolveBackfillBudgetMs } from "../src/kz/competitors/load.js";
import { collectPlansMonitor } from "../src/bitrix/salesPult/plans/collect.js";
import { collectRadarView } from "../src/bitrix/salesPult/radar/collect.js";
import { buildMorningPulse, lossPulseItems, pulseForPayload, selectHotLots, stockDemandPulseItems, type PulseItem, type PulseView } from "../src/bitrix/salesPult/pulse.js";
import { summarizeRecentCheaperRejections } from "../src/kz/competitors/losses.js";
import type { RadarView } from "../src/bitrix/salesPult/radar/types.js";
import type { FinanceView } from "../src/bitrix/salesPult/finance/types.js";
import {
  backfillMarketByMonths,
  DEFAULT_MARKET_UNITS_PATH,
  loadStoredMarketData
} from "../src/kz/market/fetchMarket.js";

export interface PultConfig {
  portal: string;
  timezone: string;
  timezoneOffsetHours: number;
  chatDialogId: string;
  pultUrl: string;
  proposalsTracked?: boolean;
  maxOverdueDays?: number;
  topTaskCategories?: number[];
  holidays?: string[];
  targets: {
    daily: { calls: number; proposals: number; contracts: number };
    weekly: { calls: number; proposals: number; contracts: number };
    monthly: { calls: number; proposals: number; contracts: number };
  };
  stages: {
    proposals: string[];
    contracts: string[];
  };
  groups: Array<{
    id: string;
    name: string;
    trackedMetrics: string[];
    managers: Array<{ id: string; name: string }>;
  }>;
  /** Ушедшие, которые в Битриксе ещё активны: на «Планах» не получают строки менеджера. Неактивных пульт скрывает сам. */
  formerManagers?: Array<{ id: string; name: string }>;
  register?: {
    diskFolderId?: number;
    managerAliases?: Record<string, string>;
    hiddenManagers?: string[];
  };
  /** Ежедневный отчёт финансиста: папка файлов чата «Финансовый отчет» на Диске Битрикс24. */
  finance?: {
    diskFolderId?: number;
  };
}

export function loadConfig(customPath?: string): PultConfig {
  const configPath = customPath || "config/sales-pult.json";
  const raw = fs.readFileSync(path.resolve(configPath), "utf8");
  return JSON.parse(raw) as PultConfig;
}

/**
 * Fetches recent chat messages with pagination by LAST_ID.
 */
export async function fetchRecentChatMessages(
  client: ReadOnlyBitrixClient,
  dialogId: string,
  targetCount = 200
): Promise<Array<{ id?: number | string; text?: string | null; date?: string; author_id?: number | string }>> {
  const allMessages: Array<{ id?: number | string; text?: string | null; date?: string; author_id?: number | string }> = [];
  let lastId: number | undefined;

  while (allMessages.length < targetCount) {
    const limit = Math.min(50, targetCount - allMessages.length);
    const params: Record<string, unknown> = {
      DIALOG_ID: dialogId,
      LIMIT: limit
    };
    if (lastId !== undefined) {
      params.LAST_ID = lastId;
    }
    const res = (await client.call("im.dialog.messages.get", params)) as {
      messages?: Array<{ id: number | string; text?: string | null; date?: string; author_id?: number | string }>;
    };
    const batch = res?.messages || [];
    if (batch.length === 0) break;

    allMessages.push(...batch);

    const numericIds = batch
      .map((m) => Number(m.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numericIds.length === 0) break;
    const minId = Math.min(...numericIds);
    if (lastId !== undefined && minId >= lastId) break;
    lastId = minId;
    if (batch.length < limit) break;
  }

  return allMessages;
}

/**
 * Fetches messages backwards until messages reach older than cutoffDate.
 */
export async function fetchChatMessagesSince(
  client: ReadOnlyBitrixClient,
  dialogId: string,
  cutoffDate: string,
  maxLimit = 1000
): Promise<Array<{ id?: number | string; text?: string | null; date?: string; author_id?: number | string }>> {
  const allMessages: Array<{ id?: number | string; text?: string | null; date?: string; author_id?: number | string }> = [];
  let lastId: number | undefined;

  while (allMessages.length < maxLimit) {
    const params: Record<string, unknown> = {
      DIALOG_ID: dialogId,
      LIMIT: 50
    };
    if (lastId !== undefined) {
      params.LAST_ID = lastId;
    }
    const res = (await client.call("im.dialog.messages.get", params)) as {
      messages?: Array<{ id: number | string; text?: string | null; date?: string; author_id?: number | string }>;
    };
    const batch = res?.messages || [];
    if (batch.length === 0) break;

    allMessages.push(...batch);

    const oldestInBatch = batch[batch.length - 1];
    if (oldestInBatch?.date) {
      const oldestDate = toAlmatyDate(oldestInBatch.date);
      if (oldestDate < cutoffDate) {
        break;
      }
    }

    const numericIds = batch
      .map((m) => Number(m.id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numericIds.length === 0) break;
    const minId = Math.min(...numericIds);
    if (lastId !== undefined && minId >= lastId) break;
    lastId = minId;
    if (batch.length < 50) break;
  }

  return allMessages;
}

export function writeMarketMonthContractFiles(options: {
  outDir: string;
  todayAlmaty: string;
  unitsFilePath?: string;
  educationVerdictsFilePath?: string;
  cfg?: MarketConfig;
  additionalMonths?: string[];
}): { ipMonths: string[]; ktMonths: string[] } {
  const marketDir = path.join(options.outDir, "market");
  fs.rmSync(marketDir, { recursive: true, force: true });

  const stored = loadStoredMarketData(options.unitsFilePath ?? DEFAULT_MARKET_UNITS_PATH);
  if (stored.units.length === 0) {
    return { ipMonths: [], ktMonths: [] };
  }
  const cfg = options.cfg ?? loadMarketConfig();
  const verdicts = loadEducationVerdicts(options.educationVerdictsFilePath);
  const filtered = filterMarketUnitsForView(stored.units, cfg, verdicts);
  const byGroup = buildAllMarketMonthContracts(
    filtered.units,
    options.todayAlmaty,
    cfg,
    filtered.educationPending,
    options.additionalMonths ?? []
  );

  for (const [groupSlug, monthsMap] of [
    ["ip", byGroup.ip],
    ["kt", byGroup.kt]
  ] as const) {
    const groupDir = path.join(marketDir, groupSlug);
    fs.mkdirSync(groupDir, { recursive: true });
    for (const [month, monthPayload] of Object.entries(monthsMap)) {
      fs.writeFileSync(path.join(groupDir, `${month}.json`), JSON.stringify(monthPayload), "utf8");
    }
  }
  return {
    ipMonths: Object.keys(byGroup.ip).sort(),
    ktMonths: Object.keys(byGroup.kt).sort()
  };
}

export class SalesPultCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesPultCliError";
  }
}

export interface SalesPultRunOptions {
  config?: PultConfig;
  rawClient?: Pick<BitrixClient, "call">;
  reader?: ReadOnlyBitrixClient;
  nowIso?: string;
  webhookUrl?: string;
  skipUpdates?: boolean;
  /**
   * «Конкуренты» для утреннего дайджеста. Не задано: при `skipUpdates` (тесты) локальная база не читается,
   * иначе — `loadCompetitorsView` из `data/competitors`.
   */
  loadCompetitors?: (todayAlmaty: string) => CompetitorsView | null;
}

/** Пульс не роняет сборку пульта: сбой — страница без пульса, в лог только класс ошибки. */
function buildPulseSafely(build: () => PulseView | null): PulseView | null {
  try {
    return build();
  } catch (err) {
    console.warn(`[Пульс] Не собран (${formatSafeErrorStatus(err)})`);
    return null;
  }
}

export async function runSalesPult(args: string[], options?: SalesPultRunOptions): Promise<void> {
  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : "site";
  const dryRun = args.includes("--dry-run");
  const execute = args.includes("--execute") && !dryRun;
  const compareManual = args.includes("--compare-manual");
  const daysIdx = args.indexOf("--days");
  const daysCount = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 10;
  const registerFileIdx = args.indexOf("--register-file");
  const registerFilePath = registerFileIdx !== -1 && args[registerFileIdx + 1] ? args[registerFileIdx + 1] : undefined;
  // --finance-file можно повторить: ежедневный отчёт и книга ФО (ОПиУ) — тип файла решают листы.
  const financeFiles = args.flatMap((a, i) => (a === "--finance-file" && args[i + 1] ? [args[i + 1]] : []));
  const refreshHistory = args.includes("--refresh-history");
  const historyCacheIdx = args.indexOf("--history-cache");
  const historyCachePath = historyCacheIdx !== -1 && args[historyCacheIdx + 1] ? args[historyCacheIdx + 1] : undefined;
  const backfillIdx = args.indexOf("--market-backfill-from");
  const backfillFromDate = backfillIdx !== -1 && args[backfillIdx + 1] ? args[backfillIdx + 1] : undefined;
  const marketUpdate = args.includes("--market-update");
  const compBackfillIdx = args.indexOf("--competitors-backfill-from");
  const compBackfillFrom = compBackfillIdx !== -1 && args[compBackfillIdx + 1] ? args[compBackfillIdx + 1] : undefined;
  const compUpdate = args.includes("--competitors-update");

  const config = options?.config ?? loadConfig();
  const webhookUrl = options?.webhookUrl ?? process.env.BITRIX24_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new SalesPultCliError("Missing BITRIX24_WEBHOOK_URL in environment (.env)");
  }

  const rawClient = options?.rawClient ?? new BitrixClient(webhookUrl);
  const reader = options?.reader ?? new ReadOnlyBitrixClient(rawClient as BitrixClient);

  const nowIso = options?.nowIso ?? new Date().toISOString();
  const todayAlmaty = toAlmatyDate(nowIso);

  if (backfillFromDate) {
    // Рынок берём из открытого API zakup.gov.kz; токен нужен только запасному ows.
    const gzToken = process.env.GOSZAKUP_TOKEN?.trim() || null;
    console.log(`[Рынок] Начало загрузки с ${backfillFromDate} по месяцам с сохранением прогресса...`);
    try {
      const units = await backfillMarketByMonths({
        token: gzToken,
        fromDate: backfillFromDate,
        toDate: todayAlmaty,
        onProgress: (info) => {
          const source = info.source ? `, источник ${info.source}` : "";
          console.log(`[Рынок] Месяц ${info.month}: отобрано ${info.matched}, всего сохранено ${info.totalSaved}${source}`);
        }
      });
      console.log(`[Рынок] Завершено. Сохранено ${units.length} позиций в ${DEFAULT_MARKET_UNITS_PATH}`);
    } catch (err: any) {
      console.warn(`::warning::[Рынок] Ошибка при докачке рынка: ${err?.message || err}`);
    }
    if (args.length <= 2 && !compBackfillFrom) return;
  }

  if (compBackfillFrom) {
    console.log(`[Конкуренты] Полная докачка с ${compBackfillFrom} по ${todayAlmaty}...`);
    try {
      const stats = await backfillCompetitors({
        fromDate: compBackfillFrom,
        toDate: todayAlmaty,
        maxDurationMs: resolveBackfillBudgetMs(args),
        onProgress: (stage, detail) => {
          console.log(`[Конкуренты] ${stage}: ${detail}`);
        }
      });
      console.log(`[Конкуренты] Докачка завершена: лотов ${stats.lotsCount}, заявок ${stats.bidsCount}, ТС ${stats.specsCount}, ошибок ${stats.errors.length}`);
    } catch (err: any) {
      console.warn(`::warning::[Конкуренты] Ошибка при докачке: ${err?.message || err}`);
    }
    if (args.length <= 2) return;
  }

  if (!options?.skipUpdates && (mode === "morning" || marketUpdate)) {
    const total = await updateMarketWindow({
      todayAlmaty,
      token: process.env.GOSZAKUP_TOKEN?.trim() || null,
      strict: args.includes("--market-update-strict")
    });
    if (process.env.MARKET_RESEED === "true" && total !== undefined) {
      console.log(`[Рынок] Восстановление: в копии ${process.env.MARKET_SEED_COUNT}, после импорта комплектов ${process.env.MARKET_EDUCATION_COUNT}, после обновления окна ${total}`);
    }
  }

  if (!options?.skipUpdates && (mode === "morning" || compUpdate)) {
    await updateCompetitorsWindow({
      todayAlmaty,
      strict: args.includes("--competitors-update-strict")
    });
  }

  // Weekend and holiday check for scheduled reporting modes
  if (mode === "morning" || mode === "evening") {
    const d = new Date(Date.parse(`${todayAlmaty}T12:00:00Z`));
    const dayOfWeek = d.getUTCDay(); // 0 is Sun, 6 is Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = Array.isArray(config.holidays) && config.holidays.includes(todayAlmaty);

    if (isWeekend || isHoliday) {
      console.log(`Выходной / праздничный день (${todayAlmaty}), отправка отчетов пропущена.`);
      return;
    }
  }

  const startDate = getPultCollectionStartDate(todayAlmaty);
  const allManagerIds = config.groups.flatMap((g) => g.managers.map((m) => m.id));
  const webhookUserId = extractWebhookUserId(webhookUrl);

  // Mode: Compare Manual
  if (compareManual) {
    console.log(`\n=== Сверка ручных отчетов за последние ${daysCount} дней ===`);
    const cutoffObj = new Date(Date.parse(`${todayAlmaty}T12:00:00Z`));
    cutoffObj.setDate(cutoffObj.getDate() - daysCount);
    const cutoffDate = cutoffObj.toISOString().slice(0, 10);

    const messages = await fetchChatMessagesSince(reader, config.chatDialogId, cutoffDate);
    const manualReports: ParsedManualReport[] = [];
    for (const msg of messages) {
      if (!msg.text) continue;
      const parsed = parseManualReport(msg.text);
      if (parsed.managerName && parsed.date && parsed.date >= cutoffDate) {
        manualReports.push(parsed);
      }
    }

    console.log(`Найдено ручных отчетов в чате: ${manualReports.length}`);

    // Load auto data from earliest manual report or startDate
    const earliestReportDate = manualReports.reduce(
      (min, r) => (r.date && r.date < min ? r.date : min),
      startDate
    );
    const autoStartDate = earliestReportDate < startDate ? earliestReportDate : startDate;

    const collected = await collectPultData({
      client: reader,
      fromDate: autoStartDate,
      toDate: todayAlmaty,
      managerIds: allManagerIds,
      proposalStages: config.stages.proposals,
      contractStages: config.stages.contracts,
      nowIso,
      maxOverdueDays: config.maxOverdueDays ?? 30,
      topTaskCategories: config.topTaskCategories,
      holidays: config.holidays,

      webhookUserId
    });

    const datesForMetrics = getDateRange(autoStartDate, todayAlmaty);
    const dailyMetricsList: DailyActivityMetrics[] = [];
    for (const mId of allManagerIds) {
      for (const d of datesForMetrics) {
        dailyMetricsList.push(
          calculateDailyMetrics({
            managerId: mId,
            date: d,
            calls: collected.calls,
            kpTransitions: collected.kpTransitions,
            contractTransitions: collected.contractTransitions,
            deals: collected.deals
          })
        );
      }
    }

    console.log("\n| Менеджер | Дата | День: Звонки (а/р) | День: ТС/КП (а/р) | День: Договоры (а/р) | Месяц: Звонки (а/р) | Месяц: ТС/КП (а/р) | Месяц: Договоры (а/р) | Месяц: Сумма (а/р) |");
    console.log("|---|---|---|---|---|---|---|---|---|");

    const managersWithContractDiscrepancy = new Set<string>();
    const latestRollupsByManager = new Map<string, ManagerRollups>();
    const latestManualReportByManager = new Map<string, ParsedManualReport>();

    for (const rep of manualReports) {
      const mgr = config.groups.flatMap((g) => g.managers).find(
        (m) => m.name.toLowerCase().includes((rep.managerName ?? "").toLowerCase()) ||
               (rep.managerName ?? "").toLowerCase().includes(m.name.toLowerCase())
      );
      if (!mgr) continue;

      const dateStr = rep.date ?? todayAlmaty;
      const rollups = calculateRollups({
        managerId: mgr.id,
        asOfDate: dateStr,
        dailyMetrics: dailyMetricsList,
        deals: collected.deals,
        targets: config.targets
      });

      if (!latestRollupsByManager.has(mgr.id)) {
        latestRollupsByManager.set(mgr.id, rollups);
      }
      if (!latestManualReportByManager.has(mgr.id)) {
        latestManualReportByManager.set(mgr.id, rep);
      }

      const dayCalls = `${rollups.day.calls.successful} / ${rep.day.callsFact}`;
      const dayKp = `${rollups.day.proposals.uniqueDealsCount} / ${rep.day.proposalsFact}`;
      const dayContracts = `${rollups.day.contracts.uniqueDealsCount} / ${rep.day.contractsFact}`;

      const monthCalls = `${rollups.month.calls.successful} / ${rep.month.callsFact}`;
      const monthKp = `${rollups.month.proposals.uniqueDealsCount} / ${rep.month.proposalsFact}`;
      const monthContracts = `${rollups.month.contracts.uniqueDealsCount} / ${rep.month.contractsFact}`;
      const monthAmount = `${formatMoney(rollups.month.contracts.totalAmount)} / ${formatMoney(rep.month.amountFact)}`;

      if (rollups.month.contracts.uniqueDealsCount !== rep.month.contractsFact) {
        managersWithContractDiscrepancy.add(mgr.id);
      }

      console.log(`| ${mgr.name} (${mgr.id}) | ${dateStr} | ${dayCalls} | ${dayKp} | ${dayContracts} | ${monthCalls} | ${monthKp} | ${monthContracts} | ${monthAmount} |`);
    }

    // Dynamic breakdown of deals that entered proposal stages or C41:EXECUTING (including before the month) and are in open stages
    if (managersWithContractDiscrepancy.size > 0) {
      console.log("\n\n### Сделки менеджеров с расхождением по договорам (открытые стадии в КП или «Договорился»)\n");
      console.log("| Менеджер | ID | Воронка | Текущая стадия | Сумма | Ответственный | Название |");
      console.log("|---|---|---|---|---|---|---|");

      const proposalStages = config.stages.proposals;
      const stagesToInspect = Array.from(new Set([...proposalStages, "C41:EXECUTING"]));
      const currentMonthStart = `${todayAlmaty.slice(0, 7)}-01T00:00:00+03:00`;

      const candidateDealIds = new Set<string>();

      // 1. Transitions into these stages this month
      for (const stage of stagesToInspect) {
        const items = await reader.listAllBatched<{ OWNER_ID?: string | number }>(
          "crm.stagehistory.list",
          {
            entityTypeId: 2,
            filter: { STAGE_ID: stage, ">=CREATED_TIME": currentMonthStart },
            order: { ID: "ASC" },
            select: ["ID", "OWNER_ID", "STAGE_ID", "CREATED_TIME"]
          },
          "items"
        );
        for (const item of items) {
          if (item.OWNER_ID) {
            candidateDealIds.add(String(item.OWNER_ID));
          }
        }
      }

      // 2. Deals currently in these stages (covers entered before this month and still there)
      const discrepancyManagerIds = Array.from(managersWithContractDiscrepancy);
      const assignedFilter = discrepancyManagerIds.length === 1
        ? discrepancyManagerIds[0]
        : discrepancyManagerIds;

      for (const stage of stagesToInspect) {
        const rows = await reader.listAllBatched<{ ID?: string | number }>(
          "crm.deal.list",
          {
            filter: {
              STAGE_ID: stage,
              ASSIGNED_BY_ID: assignedFilter
            },
            order: { ID: "ASC" },
            select: ["ID"]
          }
        );
        for (const r of rows) {
          if (r.ID) candidateDealIds.add(String(r.ID));
        }
      }

      const candidateIdsArray = Array.from(candidateDealIds);
      const candidateDeals: Array<{
        ID: string;
        TITLE?: string;
        CATEGORY_ID?: string | number;
        STAGE_ID?: string;
        OPPORTUNITY?: string | number;
        ASSIGNED_BY_ID?: string | number;
      }> = [];

      const batchSize = 50;
      for (let i = 0; i < candidateIdsArray.length; i += batchSize) {
        const chunk = candidateIdsArray.slice(i, i + batchSize);
        const rows = (await reader.call("crm.deal.list", {
          filter: { ID: chunk },
          select: ["ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "OPPORTUNITY", "ASSIGNED_BY_ID"]
        })) as Array<{
          ID: string;
          TITLE?: string;
          CATEGORY_ID?: string | number;
          STAGE_ID?: string;
          OPPORTUNITY?: string | number;
          ASSIGNED_BY_ID?: string | number;
        }>;
        if (Array.isArray(rows)) {
          candidateDeals.push(...rows);
        }
      }

      // Open stages filter: strictly exclude WON, LOSE, DUPLICATE, APOLOGY
      const isOpenDeal = (stageId?: string | null): boolean => {
        const s = String(stageId ?? "").toUpperCase();
        if (s.endsWith(":WON") || s === "WON") return false;
        if (s.endsWith(":LOSE") || s === "LOSE") return false;
        if (s.includes("DUPLICATE") || s.includes("APOLOGY")) return false;
        return true;
      };

      const openDeals = candidateDeals.filter((d) => isOpenDeal(d.STAGE_ID));

      const allManagersMap = new Map(config.groups.flatMap((g) => g.managers).map((m) => [m.id, m.name]));

      for (const mgrId of managersWithContractDiscrepancy) {
        const mgrName = allManagersMap.get(mgrId) || mgrId;
        const mgrDeals = openDeals.filter((d) => String(d.ASSIGNED_BY_ID) === mgrId);

        for (const d of mgrDeals) {
          const cat = String(d.CATEGORY_ID ?? "");
          const stage = String(d.STAGE_ID ?? "");
          const opp = Number(d.OPPORTUNITY ?? 0);
          const assigned = String(d.ASSIGNED_BY_ID ?? "");
          const title = String(d.TITLE ?? "").replace(/\|/g, "/");
          console.log(`| ${mgrName} (${mgrId}) | #${d.ID} | ${cat} | ${stage} | ${formatMoney(opp)} | ${assigned} | ${title} |`);
        }
      }

      console.log("\n\n### Итоги по менеджерам с расхождениями\n");
      console.log("| Менеджер | Выиграно в CRM (WON) | Висит в КП и «Договорился» | Ручной отчёт (факт) | Разница (Ручной − Выиграно) |");
      console.log("|---|---|---|---|---|");

      for (const mgrId of managersWithContractDiscrepancy) {
        const mgrName = allManagersMap.get(mgrId) || mgrId;
        const rollups = latestRollupsByManager.get(mgrId);
        const rep = latestManualReportByManager.get(mgrId);

        const wonCount = rollups ? rollups.month.contracts.uniqueDealsCount : 0;
        const wonAmount = rollups ? rollups.month.contracts.totalAmount : 0;

        const mgrPendingDeals = openDeals.filter(
          (d) => String(d.ASSIGNED_BY_ID) === mgrId && stagesToInspect.includes(String(d.STAGE_ID))
        );
        const pendingCount = mgrPendingDeals.length;
        const pendingAmount = mgrPendingDeals.reduce((sum, d) => sum + Number(d.OPPORTUNITY ?? 0), 0);

        const manualCount = rep ? rep.month.contractsFact : 0;
        const manualAmount = rep ? rep.month.amountFact : 0;

        const diffCount = manualCount - wonCount;
        const diffAmount = manualAmount - wonAmount;
        const diffSign = diffAmount >= 0 ? "+" : "";
        const diffCountSign = diffCount >= 0 ? "+" : "";

        console.log(
          `| ${mgrName} (${mgrId}) | ${formatMoney(wonAmount)} (${wonCount}) | ${formatMoney(pendingAmount)} (${pendingCount}) | ${formatMoney(manualAmount)} (${manualCount}) | ${diffSign}${formatMoney(diffAmount)} (${diffCountSign}${diffCount}) |`
        );
      }
      console.log("");
    }

    return;
  }

  // Load core data
  console.log(`[Sales Pult] Загрузка данных с ${startDate} по ${todayAlmaty}...`);
  const collected = await collectPultData({
    client: reader,
    fromDate: startDate,
    toDate: todayAlmaty,
    managerIds: allManagerIds,
    proposalStages: config.stages.proposals,
    contractStages: config.stages.contracts,
    nowIso,
    maxOverdueDays: config.maxOverdueDays ?? 30,
    topTaskCategories: config.topTaskCategories,
    holidays: config.holidays,
    webhookUserId
  });

  // Check and report activity loading errors (anonymized count only)
  let hasTaskErrors = false;
  if (collected.taskErrorsByManager && collected.taskErrorsByManager.size > 0) {
    hasTaskErrors = true;
    console.error(
      `[ОШИБКА] Не удалось загрузить задачи: затронуто менеджеров ${collected.taskErrorsByManager.size}.`
    );
  }

  const allDates = getDateRange(startDate, todayAlmaty);
  const dailyMetricsList: DailyActivityMetrics[] = [];
  for (const mId of allManagerIds) {
    for (const d of allDates) {
      dailyMetricsList.push(
        calculateDailyMetrics({
          managerId: mId,
          date: d,
          calls: collected.calls,
          kpTransitions: collected.kpTransitions,
          contractTransitions: collected.contractTransitions,
          deals: collected.deals
        })
      );
    }
  }

  const rollupsByManager = new Map<string, ManagerRollups>();
  const topTasksByManager = collected.tasksByManager;

  for (const mId of allManagerIds) {
    const rollups = calculateRollups({
      managerId: mId,
      asOfDate: todayAlmaty,
      dailyMetrics: dailyMetricsList,
      deals: collected.deals,
      targets: config.targets
    });
    rollupsByManager.set(mId, rollups);
  }

  // Mode: Site
  if (mode === "site") {
    console.log("[Sales Pult] Генерация веб-пульта...");

    const groupsView: PultGroupView[] = config.groups.map((g) => ({
      id: g.id,
      name: g.name,
      managers: g.managers.map((m) => {
        const rollups = rollupsByManager.get(m.id)!;
        const topTasks = topTasksByManager.get(m.id) || [];
        const profile = collected.userProfiles.get(m.id);
        return {
          id: m.id,
          name: profile?.name || m.name,
          active: profile?.active ?? true,
          rollups,
          topTasks,
          debts: collected.debtsByManager.get(m.id)
        };
      })
    }));

    // Dynamics by day for the month
    const monthDates = getMonthDates(todayAlmaty);
    const dynamics: DayDynamic[] = monthDates.map((dateStr) => {
      const dayMetrics = dailyMetricsList.filter((m) => m.date === dateStr);
      const calls = dayMetrics.reduce((s, m) => s + m.calls.successful, 0);
      const proposals = dayMetrics.reduce((s, m) => s + m.proposals.uniqueDealsCount, 0);
      const contracts = dayMetrics.reduce((s, m) => s + m.contracts.uniqueDealsCount, 0);
      const amount = dayMetrics.reduce((s, m) => s + m.contracts.totalAmount, 0);
      return {
        date: dateStr,
        calls,
        proposals,
        contracts,
        amount
      };
    });

    const almatyTime = formatAlmatyTime(nowIso);
    const generatedTimeStr = `${todayAlmaty} ${almatyTime} (UTC+5)`;

    // Register
    const registerView = await loadRegisterView({
      reader,
      diskFolderId: config.register?.diskFolderId,
      managerAliases: config.register?.managerAliases,
      hiddenManagers: config.register?.hiddenManagers,
      registerFilePath,
      todayAlmaty,
      contractTransitions: collected.contractTransitions,
      userProfiles: collected.userProfiles,
      contractStages: config.stages.contracts,
      refreshHistory,
      historyCachePath,
      holidays: config.holidays
    });

    // Финансы: отчёт финансиста из чата, отдельная страница fin.html. Сбой здесь не должен ронять пульт.
    const financeView = await loadFinanceView({
      reader,
      folderId: config.finance?.diskFolderId,
      localFiles: financeFiles
    }).catch((err: unknown) => {
      console.warn(`[Финансы] Не загрузились (${(err as Error)?.name || "Error"})`);
      return { snapshots: [], error: "Финансовый отчёт не загрузился при сборке пульта, попробуем на следующем обновлении." };
    });

    // Market
    const marketView = loadMarketView({
      todayAlmaty
    });
    const competitorsView = loadCompetitorsView({
      todayAlmaty
    });

    let planDealsForRadar: import("../src/bitrix/salesPult/plans/types.js").NormalizedPlanDeal[] = [];
    const plansView = await collectPlansMonitor({
      reader,
      asOfDate: todayAlmaty,
      portal: config.portal,
      userProfiles: collected.userProfiles,
      groups: config.groups,
      formerManagerIds: config.formerManagers?.map((m) => m.id),
      onDeals: (deals) => { planDealsForRadar = deals; }
    });
    const radarView = await collectRadarView({
      reader,
      asOfDate: todayAlmaty,
      asOfTime: nowIso,
      portal: config.portal,
      userProfiles: collected.userProfiles,
      groups: config.groups,
      planDeals: planDealsForRadar
    });

    const payload: SalesPultPayload = {
      asOfDate: todayAlmaty,
      generatedAt: generatedTimeStr,
      portal: config.portal,
      pultUrl: config.pultUrl,
      proposalsTracked: config.proposalsTracked ?? false,
      targets: config.targets,
      callsAvailable: collected.callsAvailable,
      callsError: collected.callsError,
      groups: groupsView,
      dynamics,
      holidays: config.holidays,
      market: marketView,
      competitors: competitorsView,
      plans: plansView,
      radar: radarView,
      outcomeMismatches: collected.outcomeMismatches
    };
    // Склад 1С из финансового отчёта — штуками по видам, без сумм и названий: теги на Радаре и в Планах, спрос на «Финансах».
    const stockView = buildStockAvailability(financeView, todayAlmaty);
    payload.stock = stockView && withStockHints(stockView, radarView, plansView);
    const stockDemand = buildStockDemand(stockView, radarView, plansView);
    console.log(`[Склад] строк по видам: ${stockView?.rows.length ?? 0}, карточек с подсказкой: ${payload.stock?.hints?.reduce((s, h) => s + h.ids.length, 0) ?? 0}, строк спроса: ${stockDemand.length}${stockView?.stale ? ", отчёт устарел" : ""}`);

    payload.closedMonths = await loadClosedMonths(todayAlmaty, "data/pult-months", JSON.stringify(config) + ":contracts-op-v1", async (month) => {
      const started = performance.now();
      const history = await collectPultData({
        client: reader, fromDate: month.from, toDate: month.to,
        managerIds: allManagerIds, proposalStages: config.stages.proposals,
        contractStages: config.stages.contracts, historyOnly: true
      });
      const daily = allManagerIds.flatMap((managerId) => getDateRange(month.from, month.to).map((date) =>
        calculateDailyMetrics({ managerId, date, calls: history.calls,
          kpTransitions: history.kpTransitions, contractTransitions: history.contractTransitions, deals: history.deals })));
      const groups = config.groups.map((g) => ({ id: g.id, name: g.name, managers: g.managers.map((m) => ({
        id: m.id, name: collected.userProfiles.get(m.id)?.name || m.name,
        // Истории состава нет: используем текущий состав, это явно подписано в пульте.
        active: collected.userProfiles.get(m.id)?.active ?? true, topTasks: [],
        rollups: calculateRollups({ managerId: m.id, asOfDate: month.to,
          dailyMetrics: daily, deals: history.deals, targets: config.targets })
      })) }));
      const dynamics = getDateRange(month.from, month.to).map((date) => {
        const rows = daily.filter((r) => r.date === date);
        return { date, calls: rows.reduce((s, r) => s + r.calls.successful, 0),
          proposals: rows.reduce((s, r) => s + r.proposals.uniqueDealsCount, 0),
          contracts: rows.reduce((s, r) => s + r.contracts.uniqueDealsCount, 0),
          amount: rows.reduce((s, r) => s + r.contracts.totalAmount, 0) };
      });
      console.log(`[Пульт] История ${month.key}: ${Math.round(performance.now() - started)} мс`);
      return { asOfDate: month.to, generatedAt: `${month.to} 23:59 (UTC+5)`, closedMonth: true,
        portal: config.portal, targets: config.targets, holidays: config.holidays,
        callsAvailable: history.callsAvailable, callsError: history.callsError,
        proposalsTracked: config.proposalsTracked, groups, dynamics };
    });

    for (const metric of dailyMetricsList) {
      for (const id of metric.contracts.dealIds) {
        const deal = collected.deals.get(id);
        if (deal && (!deal.contractDate || metric.date < deal.contractDate)) deal.contractDate = metric.date;
      }
    }
    attachRegisterContracts(payload, registerView, collected.deals, config.register?.managerAliases, collected.userProfiles);
    for (const closed of Object.values(payload.closedMonths)) {
      if (closed) attachRegisterContracts(closed, registerView, new Map(), config.register?.managerAliases);
    }
    payload.pulse = buildPulseSafely(() => pulseForPayload(payload, {
      nowIso, finance: financeView, register: registerView,
      extraItems: [
        ...lossPulseItems(summarizeRecentCheaperRejections(competitorsView, todayAlmaty)),
        ...stockDemandPulseItems(summarizeStagnantDemand(payload.stock, radarView, plansView))
      ]
    }));

    const outDir = path.resolve("exports/sales-pult");
    fs.mkdirSync(outDir, { recursive: true });

    // 1. Main pult page (no register in payload or DOM)
    const html = renderPultHtml(payload);
    fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
    fs.writeFileSync(path.join(outDir, "payload.json"), JSON.stringify(payload, null, 2), "utf8");
    const marketFiles = writeMarketMonthContractFiles({ outDir, todayAlmaty });
    if (marketFiles.ipMonths.length || marketFiles.ktMonths.length) {
      console.log(`[Рынок] Помесячные JSON: ИП ${marketFiles.ipMonths.length} мес., КТ ${marketFiles.ktMonths.length} мес.`);
    }
    // Все сделки «Планов»: из них при выкладке собираются «Планы» в виде менеджера (на сайт файл не идёт).
    if (!plansView.error) fs.writeFileSync(path.join(outDir, "plan-deals.json"), JSON.stringify(planDealsForRadar), "utf8");

    // 2. Standalone register page
    const regPayload: RegisterPagePayload = {
      asOfDate: todayAlmaty,
      generatedAt: generatedTimeStr,
      portal: config.portal,
      pultUrl: config.pultUrl,
      register: registerView,
      reconciliation: payload.contractSource?.reconciliation
    };
    const regHtml = renderRegisterHtml(regPayload);
    fs.writeFileSync(path.join(outDir, "reg.html"), regHtml, "utf8");
    fs.writeFileSync(path.join(outDir, "payload-reg.json"), JSON.stringify(regPayload, null, 2), "utf8");

    // 3. Финансы: только в полный вариант (pult-variants.mts), менеджеру и на ТВ не идёт
    const finPayload: FinancePagePayload = { asOfDate: todayAlmaty, generatedAt: generatedTimeStr, finance: financeView, stockDemand };
    fs.writeFileSync(path.join(outDir, "fin.html"), renderFinanceHtml(finPayload), "utf8");
    fs.writeFileSync(path.join(outDir, "payload-fin.json"), JSON.stringify(finPayload, null, 2), "utf8");

    console.log(`[Sales Pult] Готово: index.html, reg.html, fin.html и payload.json`);
    if (hasTaskErrors) {
      process.exitCode = 1;
    }
    return;
  }

  // Modes: morning / evening
  if (mode === "morning" || mode === "evening") {
    console.log(`\n=== Режим: ${mode.toUpperCase()} (execute: ${execute}) ===\n`);

    // Утро: горящие лоты менеджерам и дайджест директору. Любой сбой здесь утренний режим не роняет.
    let morningRadar: RadarView | null = null;
    if (mode === "morning") {
      morningRadar = await collectRadarView({
        reader, asOfDate: todayAlmaty, asOfTime: nowIso, portal: config.portal,
        userProfiles: collected.userProfiles, groups: config.groups
      }).catch((err: unknown) => {
        console.warn(`[Радар] Не загрузился (${formatSafeErrorStatus(err)})`);
        return null;
      });
      const morningFinance: FinanceView | undefined = await loadFinanceView({
        reader, folderId: config.finance?.diskFolderId, localFiles: financeFiles
      }).catch((err: unknown) => {
        console.warn(`[Финансы] Не загрузились (${(err as Error)?.name || "Error"})`);
        return undefined;
      });
      // «Конкуренты» — из локальной базы, обновлённой выше в этом же запуске; сбой здесь дайджест не отменяет.
      let morningExtras: PulseItem[] = [];
      try {
        const loadCompetitors = options?.loadCompetitors
          ?? (options?.skipUpdates ? () => null : (day: string) => loadCompetitorsView({ todayAlmaty: day }));
        const competitors = loadCompetitors(todayAlmaty);
        if (competitors) morningExtras = lossPulseItems(summarizeRecentCheaperRejections(competitors, todayAlmaty));
      } catch (err) {
        console.warn(`[Конкуренты] Потери для дайджеста не собраны (${formatSafeErrorStatus(err)})`);
      }
      // Склад без расхода × открытые лоты радара (планы утром не грузятся — только лоты).
      try {
        const morningStock = buildStockAvailability(morningFinance, todayAlmaty);
        morningExtras.push(...stockDemandPulseItems(summarizeStagnantDemand(morningStock, morningRadar, null)));
      } catch (err) {
        console.warn(`[Склад] Спрос для дайджеста не собран (${formatSafeErrorStatus(err)})`);
      }
      try {
        const pulse = buildMorningPulse({
          asOfDate: todayAlmaty, nowIso, finance: morningFinance, radar: morningRadar,
          outcomeMismatchesCount: collected.outcomeMismatches?.length ?? 0, extraItems: morningExtras
        });
        // Только сборка: чата директора нет, отправка — по прямой команде владельца. Текст в публичный лог не идёт.
        const digest = buildDirectorDigest(pulse, config.pultUrl);
        console.log(`[DRY-RUN] Дайджест директору сформирован (пунктов ${pulse.items.length}, длина ${digest.length} симв.)`);
        if (args.includes("--print-digest") && process.env.CI !== "true") process.stdout.write(`${digest}\n`);
      } catch (err) {
        console.warn(`[Дайджест] Не собран (${formatSafeErrorStatus(err)})`);
      }
    }

    // Fetch last 200 messages with pagination by LAST_ID for idempotency check
    let chatMessages = await fetchRecentChatMessages(reader, config.chatDialogId, 200);

    const salesGroup = config.groups.find((g) => g.id === "sales");
    const managersToReport = salesGroup ? salesGroup.managers : config.groups[0].managers;
    const totalCount = managersToReport.length;

    let sentCount = 0;
    let verifiedDeliveredAfterErrorCount = 0;
    let skippedAlreadySentCount = 0;
    let dryRunCount = 0;
    let failedCount = 0;

    for (let idx = 0; idx < managersToReport.length; idx++) {
      const m = managersToReport[idx];
      const slotLabel = `[#${idx + 1}/${totalCount}]`;
      const rollups = rollupsByManager.get(m.id)!;
      const topTasks = topTasksByManager.get(m.id) || [];
      const managerName = collected.userProfiles.get(m.id)?.name || m.name;
      const taskError = collected.taskErrorsByManager?.get(m.id) || null;

      const reportText =
        mode === "morning"
          ? buildMorningReport({
              managerId: m.id,
              managerName,
              date: todayAlmaty,
              targets: config.targets.daily,
              tasks: topTasks,
              debts: collected.debtsByManager.get(m.id),
              pultUrl: config.pultUrl,
              taskError,
              hotLots: selectHotLots(morningRadar, m.id, todayAlmaty, nowIso)
            })
          : buildEveningReport({
              managerId: m.id,
              managerName,
              rollups,
              targets: config.targets,
              pultUrl: config.pultUrl,
              callsAvailable: collected.callsAvailable,
              callsError: collected.callsError
            });

      const modeRu = mode === "morning" ? "утро" : "вечер";
      const alreadySent = isReportAlreadySent(chatMessages, todayAlmaty, modeRu, m.id);

      if (alreadySent) {
        skippedAlreadySentCount++;
        console.log(`${slotLabel} [ИДЕМПОТЕНТНОСТЬ] Отчёт уже присутствует в чате, пропуск.`);
        continue;
      }

      if (execute) {
        console.log(`${slotLabel} [ОТПРАВКА] Отправка отчёта в чат (длина ${reportText.length} симв.)...`);
        try {
          await rawClient.call(
            "im.message.add",
            {
              DIALOG_ID: config.chatDialogId,
              MESSAGE: reportText,
              URL_PREVIEW: "N"
            },
            { maxRetries: 0 }
          );
          sentCount++;
          console.log(`${slotLabel} [ОТПРАВЛЕНО] Успешно (длина ${reportText.length} симв.).`);
        } catch (sendErr) {
          console.warn(
            `${slotLabel} [ВНИМАНИЕ] Ошибка при отправке отчёта (${formatSafeErrorStatus(sendErr)}). Перечитываем чат...`
          );
          let sentAfterAll = false;
          let recheckFailed = false;
          try {
            // Re-read chat and verify marker before proceeding to next manager
            chatMessages = await fetchRecentChatMessages(reader, config.chatDialogId, 200);
            sentAfterAll = isReportAlreadySent(chatMessages, todayAlmaty, modeRu, m.id);
          } catch (recheckErr) {
            recheckFailed = true;
            console.error(
              `${slotLabel} [ОШИБКА] Не удалось перечитать чат после сбоя отправки (${formatSafeErrorStatus(recheckErr)}). Повторная отправка отменена во избежание дублей.`
            );
          }
          if (!recheckFailed && sentAfterAll) {
            verifiedDeliveredAfterErrorCount++;
            console.log(`${slotLabel} [ИДЕМПОТЕНТНОСТЬ] Маркер обнаружен в чате после сбоя запроса — сообщение доставлено.`);
          } else {
            if (!recheckFailed) {
              console.error(
                `${slotLabel} [ОШИБКА] Маркер не обнаружен. Сообщение не отправлено, но повторная отправка отменена во избежание дублей.`
              );
            }
            failedCount++;
          }
        }
      } else {
        dryRunCount++;
        console.log(
          `${slotLabel} [DRY-RUN] Отчёт сформирован (длина ${reportText.length} симв.), отправка в чат отключена (добавьте --execute для отправки).`
        );
      }
    }

    console.log(
      `[Sales Pult] Итог (${mode}): всего=${totalCount}, отправлено=${sentCount}, подтверждено_после_сбоя=${verifiedDeliveredAfterErrorCount}, пропущено_идемпотентно=${skippedAlreadySentCount}, dry_run=${dryRunCount}, ошибок_доставки=${failedCount}.`
    );

    if (failedCount > 0) {
      process.exitCode = 1;
      console.error(`[ОШИБКА ДОСТАВКИ] Отчёт не доставлен (${failedCount} из ${totalCount}).`);
    }

    if (hasTaskErrors) {
      process.exitCode = 1;
    }
    return;
  }

  throw new SalesPultCliError(`Unknown mode: ${mode}`);
}

export async function main(
  args: string[] = process.argv.slice(2),
  options?: SalesPultRunOptions
): Promise<void> {
  try {
    await runSalesPult(args, options);
  } catch (err) {
    const detail = err instanceof SalesPultCliError ? err.message : formatSafeErrorStatus(err);
    console.error(`Sales Pult Error: ${detail}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

export { formatAlmatyTime };
