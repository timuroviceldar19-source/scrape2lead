import "dotenv/config";
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
  isReportAlreadySent,
  parseManualReport,
  formatMoney,
  type ParsedManualReport
} from "../src/bitrix/salesPult/chatReport.js";
import {
  renderPultHtml,
  renderRegisterHtml,
  type SalesPultPayload,
  type RegisterPagePayload,
  type PultGroupView,
  type DayDynamic
} from "../src/bitrix/salesPult/site.js";
import { loadRegisterView } from "../src/bitrix/salesPult/register/load.js";
import { loadMarketView } from "../src/kz/market/load.js";
import {
  loadStoredMarketUnits,
  saveStoredMarketUnits,
  fetchMarketContracts,
  mergeMarketUnits,
  backfillMarketByMonths,
  DEFAULT_MARKET_UNITS_PATH
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
  register?: {
    diskFolderId?: number;
    managerAliases?: Record<string, string>;
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

export async function runSalesPult(args: string[]): Promise<void> {
  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : "site";
  const execute = args.includes("--execute");
  const compareManual = args.includes("--compare-manual");
  const daysIdx = args.indexOf("--days");
  const daysCount = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 10;
  const registerFileIdx = args.indexOf("--register-file");
  const registerFilePath = registerFileIdx !== -1 && args[registerFileIdx + 1] ? args[registerFileIdx + 1] : undefined;
  const backfillIdx = args.indexOf("--market-backfill-from");
  const backfillFromDate = backfillIdx !== -1 && args[backfillIdx + 1] ? args[backfillIdx + 1] : undefined;
  const marketUpdate = args.includes("--market-update");

  const config = loadConfig();
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error("Missing BITRIX24_WEBHOOK_URL in environment (.env)");
  }

  const rawClient = new BitrixClient(webhookUrl);
  const reader = new ReadOnlyBitrixClient(rawClient);

  const nowIso = new Date().toISOString();
  const todayAlmaty = toAlmatyDate(nowIso);

  if (backfillFromDate) {
    const gzToken = process.env.GOSZAKUP_TOKEN?.trim();
    if (!gzToken) {
      throw new Error("GOSZAKUP_TOKEN is required in .env for market backfill");
    }
    console.log(`[Рынок] Начало загрузки с ${backfillFromDate} по месяцам с сохранением прогресса...`);
    try {
      const units = await backfillMarketByMonths({
        token: gzToken,
        fromDate: backfillFromDate,
        toDate: todayAlmaty,
        onProgress: (info) => {
          console.log(`[Рынок] Месяц ${info.month}: страниц ${info.pages}, отобрано ${info.matched}, всего сохранено ${info.totalSaved}`);
        }
      });
      console.log(`[Рынок] Завершено. Сохранено ${units.length} позиций в ${DEFAULT_MARKET_UNITS_PATH}`);
    } catch (err: any) {
      console.warn(`::warning::[Рынок] Ошибка при докачке рынка: ${err?.message || err}`);
    }
    if (args.length <= 2) return;
  }

  if (mode === "morning" || marketUpdate) {
    const gzToken = process.env.GOSZAKUP_TOKEN?.trim();
    if (gzToken) {
      const d = new Date(Date.parse(`${todayAlmaty}T12:00:00Z`));
      d.setDate(d.getDate() - 45);
      const cutoffDate = d.toISOString().slice(0, 10);
      try {
        console.log(`[Рынок] Утреннее обновление за последние 45 дней (с ${cutoffDate})...`);
        const freshUnits = await fetchMarketContracts({
          token: gzToken,
          fromDate: cutoffDate,
          toDate: todayAlmaty
        });
        const existingUnits = loadStoredMarketUnits(DEFAULT_MARKET_UNITS_PATH);
        const merged = mergeMarketUnits(existingUnits, freshUnits, cutoffDate, todayAlmaty);
        saveStoredMarketUnits(merged, DEFAULT_MARKET_UNITS_PATH);
        console.log(`[Рынок] Утреннее обновление: свежих ${freshUnits.length}, всего ${merged.length}`);
      } catch (marketErr) {
        console.warn(`[Рынок] Ошибка при утреннем обновлении рынка:`, marketErr);
      }
    } else {
      console.log(`[Рынок] GOSZAKUP_TOKEN не задан, пропуск утреннего обновления рынка`);
    }
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

  // Check and report activity loading errors
  let hasTaskErrors = false;
  if (collected.taskErrorsByManager && collected.taskErrorsByManager.size > 0) {
    hasTaskErrors = true;
    for (const [mId, err] of collected.taskErrorsByManager.entries()) {
      console.error(`[ОШИБКА] Не удалось загрузить задачи для менеджера ${mId}: ${err}`);
    }
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
      registerFilePath,
      todayAlmaty,
      contractTransitions: collected.contractTransitions,
      userProfiles: collected.userProfiles
    });

    // Market
    const marketView = loadMarketView({
      todayAlmaty
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
      market: marketView
    };

    const outDir = path.resolve("exports/sales-pult");
    fs.mkdirSync(outDir, { recursive: true });

    // 1. Main pult page (no register in payload or DOM)
    const html = renderPultHtml(payload);
    fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
    fs.writeFileSync(path.join(outDir, "payload.json"), JSON.stringify(payload, null, 2), "utf8");

    // 2. Standalone register page
    const regPayload: RegisterPagePayload = {
      asOfDate: todayAlmaty,
      generatedAt: generatedTimeStr,
      portal: config.portal,
      pultUrl: config.pultUrl,
      register: registerView
    };
    const regHtml = renderRegisterHtml(regPayload);
    fs.writeFileSync(path.join(outDir, "reg.html"), regHtml, "utf8");
    fs.writeFileSync(path.join(outDir, "payload-reg.json"), JSON.stringify(regPayload, null, 2), "utf8");

    console.log(`[Sales Pult] Готово: index.html, reg.html и payload.json`);
    if (hasTaskErrors) {
      process.exitCode = 1;
    }
    return;
  }

  // Modes: morning / evening
  if (mode === "morning" || mode === "evening") {
    console.log(`\n=== Режим: ${mode.toUpperCase()} (execute: ${execute}) ===\n`);

    // Fetch last 200 messages with pagination by LAST_ID for idempotency check
    let chatMessages = await fetchRecentChatMessages(reader, config.chatDialogId, 200);

    const salesGroup = config.groups.find((g) => g.id === "sales");
    const managersToReport = salesGroup ? salesGroup.managers : config.groups[0].managers;

    const failedManagers: Array<{ id: string; name: string }> = [];

    for (const m of managersToReport) {
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
              taskError
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

      console.log(`----------------------------------------`);
      console.log(`Менеджер: ${managerName} (${m.id})`);
      if (alreadySent) {
        console.log(`[ИДЕМПОТЕНТНОСТЬ] Отчет уже присутствует в чате, пропуск.`);
        continue;
      }

      console.log(reportText);

      if (execute) {
        console.log(`[ОТПРАВКА] Отправка в ${config.chatDialogId}...`);
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
          console.log(`[ОТПРАВЛЕНО] Успешно.`);
        } catch (sendErr) {
          console.warn(
            `[ВНИМАНИЕ] Ошибка при отправке отчета для ${managerName}: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}. Перечитываем чат...`
          );
          // Re-read chat and verify marker before proceeding to next manager
          chatMessages = await fetchRecentChatMessages(reader, config.chatDialogId, 200);
          const sentAfterAll = isReportAlreadySent(chatMessages, todayAlmaty, modeRu, m.id);
          if (sentAfterAll) {
            console.log(`[ИДЕМПОТЕНТНОСТЬ] Маркер обнаружен в чате после сбоя запроса — сообщение доставлено.`);
          } else {
            console.error(`[ОШИБКА] Маркер не обнаружен. Сообщение не отправлено, но повторная отправка отменена во избежание дублей.`);
            failedManagers.push({ id: m.id, name: managerName });
          }
        }
      } else {
        console.log(`[DRY-RUN] Сообщение не отправлено (добавьте --execute для отправки).`);
      }
    }

    if (failedManagers.length > 0) {
      process.exitCode = 1;
      console.error(`\n[ОШИБКА ДОСТАВКИ] Отчёт не дошёл следующим менеджерам (${failedManagers.length}):`);
      for (const fm of failedManagers) {
        console.error(`• ${fm.name} (${fm.id})`);
      }
    }

    if (hasTaskErrors) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    await runSalesPult(args);
  } catch (err) {
    console.error("Sales Pult Error:", err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

export { formatAlmatyTime };
