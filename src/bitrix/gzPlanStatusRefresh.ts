import {
  GZ_PUBLISHED_STATUS_NAME,
  buildStatusFieldUpdates,
  type PublishedDealSnapshot
} from "./gzPublishedDealStatus.js";
import { chunkPlanNumbers } from "../kz/goszakupPlanStatusApi.js";

export const GZ_REFRESH_PIPELINE_IDS = [9, 41, 29] as const;
export const GZ_REFRESH_PLAN_NUMBER_FIELD = "UF_CRM_PLAN_ID";
export const DRY_RUN_PREVIEW_LIMIT = 20;
export const GZ_REFRESH_DEAL_SELECT = [
  "ID",
  "TITLE",
  "CATEGORY_ID",
  GZ_REFRESH_PLAN_NUMBER_FIELD,
  "UF_CRM_PLAN_STATUS",
  "UF_CRM_6627AEBD85B4D",
  "UF_CRM_S2L_GZ_PUBLISHED_AT"
] as const;

/**
 * Lifecycle order of plan-point statuses. A higher rank is a later stage; the
 * refresh never replaces a higher-ranked CRM status with a lower-ranked API one.
 * Statuses missing from this table are never compared (see unknown-status skip).
 */
const STATUS_RANKS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [0, ["Утвержден", "На проверке камерального контроля", "Ожидает подтверждения", "Изменен"]],
  [1, ["Опубликован"]],
  [2, ["Проект заявки"]],
  [3, [
    "Заявка", "Заявка подтверждена", "Заявка возвращена организатором", "Заявка отклонена",
    "Приостановлен", "На обжаловании", "Пересмотр итогов",
    "Принятие решение о пересмотре итогов", "Принятие решение об исполнении уведомления"
  ]],
  [4, [
    "Закупка состоялась", "Закупка не состоялась", "Закупка не состоялась. Изменен",
    "Отменен", "Отменен. Изменен"
  ]],
  [5, [
    "Проект договора", "Договор не заключен", "Договор не заключен. Изменен.",
    "Договор не заключен, отказ от первого победителя"
  ]],
  [6, ["Договор действует", "Договор изменен"]],
  [7, [
    "Исполнен", "Договор частично исполнен", "Договор не исполнен. Нет платежей",
    "Отказ от закупки"
  ]]
];

const RANK_BY_STATUS = new Map<string, number>(
  STATUS_RANKS.flatMap(([rank, names]) => names.map((name) => [normalizeRu(name), rank] as const))
);

export function getStatusRank(status: string): number | null {
  return RANK_BY_STATUS.get(normalizeRu(status)) ?? null;
}

export const REPROCUREMENT_API_STATUS_NAMES = new Set([
  "утвержден",
  "на проверке камерального контроля",
  "опубликован",
  "проект заявки",
  "заявка"
]);

export function isReProcurementCrmStatus(status: string): boolean {
  const norm = normalizeRu(status).replace(/[.\s]+$/, "");
  return (
    norm.startsWith("закупка не состоялась") ||
    norm.startsWith("отменен") ||
    norm.startsWith("договор не заключен")
  );
}

export function isReProcurementApiStatus(status: string): boolean {
  return REPROCUREMENT_API_STATUS_NAMES.has(normalizeRu(status).replace(/[.\s]+$/, ""));
}

export interface RefreshDeal extends PublishedDealSnapshot {
  ID?: string | number | null;
  TITLE?: string | null;
  UF_CRM_PLAN_ID?: string | number | null;
}

export interface DealFieldUpdate {
  dealId: string;
  fields: Record<string, string>;
}

export interface DealUpdateResult {
  dealId: string;
  error: string | null;
}

export interface PlanStatusRefreshDeps {
  listDeals: () => Promise<RefreshDeal[]>;
  /** Called with at most 50 plan numbers; returns rootrecordId → status. */
  fetchStatuses: (planNumbers: string[]) => Promise<Map<string, string>>;
  /** Only invoked in execute mode. */
  writeUpdates: (updates: DealFieldUpdate[]) => Promise<DealUpdateResult[]>;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type RefreshDecision =
  | { kind: "update"; from: string; to: string; isSync: boolean; fields: Record<string, string> }
  | { kind: "unchanged" }
  | { kind: "downgrade"; crmStatus: string; apiStatus: string }
  | { kind: "unknown-status"; crmStatus: string; apiStatus: string };

export function decideRefresh(deal: RefreshDeal, apiStatus: string, detectedAt: string): RefreshDecision {
  const crmStatus = text(deal.UF_CRM_PLAN_STATUS) || text(deal.UF_CRM_6627AEBD85B4D);
  const apiRank = getStatusRank(apiStatus);
  const crmRank = crmStatus ? getStatusRank(crmStatus) : null;

  const isSameStatus = normalizeRu(crmStatus) === normalizeRu(apiStatus);
  if (!isSameStatus && crmStatus) {
    if (apiRank === null || crmRank === null) return { kind: "unknown-status", crmStatus, apiStatus };
    if (crmRank > apiRank) {
      const isReProcurement = isReProcurementCrmStatus(crmStatus) && isReProcurementApiStatus(apiStatus);
      if (!isReProcurement) {
        return { kind: "downgrade", crmStatus, apiStatus };
      }
    }
  }

  const isPublished = normalizeRu(apiStatus) === normalizeRu(GZ_PUBLISHED_STATUS_NAME);
  const fields = buildStatusFieldUpdates(deal, apiStatus, detectedAt, isPublished);
  if (Object.keys(fields).length === 0) return { kind: "unchanged" };
  const isSync = Boolean(crmStatus && normalizeRu(crmStatus) === normalizeRu(apiStatus));
  return { kind: "update", from: crmStatus, to: apiStatus, isSync, fields };
}

export interface PlannedUpdate {
  dealId: string;
  title: string;
  planNumber: string;
  from: string;
  to: string;
  isSync: boolean;
  fields: Record<string, string>;
}

export interface SkippedDeal {
  dealId: string;
  title: string;
  planNumber: string;
  crmStatus: string;
  apiStatus: string;
}

export interface RefreshError {
  dealId: string | null;
  planNumber: string | null;
  message: string;
}

export interface PlanStatusRefreshReport {
  mode: "dry-run" | "execute";
  limit: number | null;
  dealId: string | null;
  date: string;
  startedAt: string;
  finishedAt: string;
  totalDeals: number;
  foundInApi: number;
  unchanged: number;
  toUpdate: number;
  transitionsCount: number;
  syncCount: number;
  transitionPairs: Array<{ from: string; to: string; count: number }>;
  syncPairs: Array<{ from: string; to: string; count: number }>;
  updatePairs: Array<{ from: string; to: string; count: number }>;
  updates: PlannedUpdate[];
  updated: number;
  notFound: number;
  skipped: number;
  skippedDowngrade: SkippedDeal[];
  skippedUnknownStatus: SkippedDeal[];
  skippedInvalidPlanNumber: Array<{ dealId: string; title: string; planNumber: string }>;
  errors: RefreshError[];
}

export interface PlanStatusRefreshOptions {
  execute: boolean;
  limit?: number | null;
  dealId?: string | null;
}

export interface ParsedCliArgs {
  execute: boolean;
  dealId: string | null;
  limit: number | null;
}

export const BATCH_RETRY_DELAY_MS = 2000;

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let execute = false;
  let dealId: string | null = null;
  let limit: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--execute") {
      execute = true;
    } else if (arg === "--deal" || arg.startsWith("--deal=")) {
      let val: string;
      if (arg === "--deal") {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          throw new Error("--deal requires a numeric deal ID");
        }
        val = next.trim();
        i++;
      } else {
        val = arg.slice("--deal=".length).trim();
      }
      if (!val || !/^\d+$/.test(val)) {
        throw new Error(`--deal must be a numeric deal ID, got "${val}"`);
      }
      dealId = val;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      let val: string;
      if (arg === "--limit") {
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
          throw new Error("--limit requires a positive integer");
        }
        val = next.trim();
        i++;
      } else {
        val = arg.slice("--limit=".length).trim();
      }
      if (!/^\d+$/.test(val) || parseInt(val, 10) <= 0) {
        throw new Error(`--limit must be a positive integer, got "${val}"`);
      }
      limit = parseInt(val, 10);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { execute, dealId, limit };
}

export function buildReportFilename(
  date: string,
  options: { dealId?: string | null; limit?: number | null }
): string {
  if (options.dealId) return `${date}-deal-${options.dealId}.json`;
  if (options.limit != null && options.limit > 0) return `${date}-limit-${options.limit}.json`;
  return `${date}.json`;
}

export async function fetchBatchWithRetry(
  numbers: string[],
  fetchStatuses: (nums: string[]) => Promise<Map<string, string>>,
  sleep: (ms: number) => Promise<void>
): Promise<Map<string, string>> {
  try {
    return await fetchStatuses(numbers);
  } catch (error) {
    if (error instanceof Error && error.name === "GoszakupAuthError") throw error;
    await sleep(BATCH_RETRY_DELAY_MS);
    return await fetchStatuses(numbers);
  }
}

interface PreparedDeal {
  deal: RefreshDeal;
  dealId: string;
  title: string;
  planNumber: string;
}

export async function runPlanStatusRefresh(
  deps: PlanStatusRefreshDeps,
  options: PlanStatusRefreshOptions
): Promise<PlanStatusRefreshReport> {
  const startedAt = deps.now();
  const detectedAt = startedAt.toISOString();
  const sleep = deps.sleep ?? defaultSleep;
  const allDeals = await deps.listDeals();
  const normalizedDealId = options.dealId ? String(options.dealId).trim() : null;
  const deals = normalizedDealId
    ? allDeals.filter((d) => text(d.ID) === normalizedDealId)
    : allDeals;

  const prepared: PreparedDeal[] = [];
  const invalid: PlanStatusRefreshReport["skippedInvalidPlanNumber"] = [];
  for (const deal of deals) {
    const entry = describeDeal(deal);
    if (/^\d+$/.test(entry.planNumber)) prepared.push(entry);
    else if (entry.planNumber) invalid.push({ dealId: entry.dealId, title: entry.title, planNumber: entry.planNumber });
  }

  const errors: RefreshError[] = [];
  const statuses = new Map<string, string>();
  const failedNumbers = new Set<string>();
  const uniquePlanNumbers = [...new Set(prepared.map((entry) => entry.planNumber))];
  const planBatches = chunkPlanNumbers(uniquePlanNumbers);

  for (const batch of planBatches) {
    try {
      const batchStatuses = await fetchBatchWithRetry(batch, deps.fetchStatuses, sleep);
      for (const [root, status] of batchStatuses) statuses.set(root, status);
    } catch (batchError) {
      if (batchError instanceof Error && batchError.name === "GoszakupAuthError") throw batchError;

      // On second failure: split in half and try halves; only then record error
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        const halves = [batch.slice(0, mid), batch.slice(mid)];
        for (const half of halves) {
          try {
            const halfStatuses = await fetchBatchWithRetry(half, deps.fetchStatuses, sleep);
            for (const [root, status] of halfStatuses) statuses.set(root, status);
          } catch (halfError) {
            if (halfError instanceof Error && halfError.name === "GoszakupAuthError") throw halfError;
            half.forEach((number) => failedNumbers.add(number));
            errors.push({ dealId: null, planNumber: half.join(","), message: messageOf(halfError) });
          }
        }
      } else {
        batch.forEach((number) => failedNumbers.add(number));
        errors.push({ dealId: null, planNumber: batch.join(","), message: messageOf(batchError) });
      }
    }
  }

  const updates: PlannedUpdate[] = [];
  const downgrades: SkippedDeal[] = [];
  const unknownStatuses: SkippedDeal[] = [];
  let foundInApi = 0;
  let unchanged = 0;
  let notFound = 0;

  for (const entry of prepared) {
    if (failedNumbers.has(entry.planNumber)) continue;
    const apiStatus = statuses.get(entry.planNumber);
    if (!apiStatus) {
      notFound += 1;
      continue;
    }
    foundInApi += 1;
    const decision = decideRefresh(entry.deal, apiStatus, detectedAt);
    if (decision.kind === "unchanged") unchanged += 1;
    else if (decision.kind === "update") {
      updates.push({
        dealId: entry.dealId,
        title: entry.title,
        planNumber: entry.planNumber,
        from: decision.from,
        to: decision.to,
        isSync: decision.isSync,
        fields: decision.fields
      });
    } else {
      const skipped = {
        dealId: entry.dealId,
        title: entry.title,
        planNumber: entry.planNumber,
        crmStatus: decision.crmStatus,
        apiStatus: decision.apiStatus
      };
      (decision.kind === "downgrade" ? downgrades : unknownStatuses).push(skipped);
    }
  }

  let updatesToWrite = updates;
  if (options.limit != null && options.limit > 0) {
    updatesToWrite = updatesToWrite.slice(0, options.limit);
  }

  const written = options.execute ? await writeAll(deps, updatesToWrite, errors) : new Set<string>();
  const finishedAt = deps.now();

  const transitions = updates.filter((u) => !u.isSync);
  const syncs = updates.filter((u) => u.isSync);

  return {
    mode: options.execute ? "execute" : "dry-run",
    limit: options.limit ?? null,
    dealId: normalizedDealId,
    date: formatLocalDate(startedAt),
    startedAt: detectedAt,
    finishedAt: finishedAt.toISOString(),
    totalDeals: deals.length,
    foundInApi,
    unchanged,
    toUpdate: updates.length,
    transitionsCount: transitions.length,
    syncCount: syncs.length,
    transitionPairs: countPairs(transitions),
    syncPairs: countPairs(syncs),
    updatePairs: countPairs(updates),
    updates,
    updated: written.size,
    notFound,
    skipped: downgrades.length + unknownStatuses.length + invalid.length,
    skippedDowngrade: downgrades,
    skippedUnknownStatus: unknownStatuses,
    skippedInvalidPlanNumber: invalid,
    errors
  };
}

async function writeAll(
  deps: PlanStatusRefreshDeps,
  updates: PlannedUpdate[],
  errors: RefreshError[]
): Promise<Set<string>> {
  const written = new Set<string>();
  if (updates.length === 0) return written;
  try {
    const results = await deps.writeUpdates(updates.map(({ dealId, fields }) => ({ dealId, fields })));
    const byId = new Map(results.map((result) => [result.dealId, result]));
    for (const update of updates) {
      const result = byId.get(update.dealId);
      if (result && !result.error) written.add(update.dealId);
      else {
        errors.push({
          dealId: update.dealId, planNumber: update.planNumber,
          message: result?.error ?? "no result returned for deal update"
        });
      }
    }
  } catch (error) {
    errors.push({ dealId: null, planNumber: null, message: `write failed: ${messageOf(error)}` });
  }
  return written;
}

function countPairs(updates: PlannedUpdate[]): PlanStatusRefreshReport["updatePairs"] {
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const update of updates) {
    const key = `${update.from}\u0000${update.to}`;
    const known = counts.get(key);
    counts.set(key, known ? { ...known, count: known.count + 1 } : { from: update.from, to: update.to, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function describeDeal(deal: RefreshDeal): PreparedDeal {
  return {
    deal,
    dealId: text(deal.ID),
    title: text(deal.TITLE),
    planNumber: text(deal.UF_CRM_PLAN_ID)
  };
}

export function formatReportLines(report: PlanStatusRefreshReport): string[] {
  const label = (value: string) => value || "—";
  const flags = [
    `mode=${report.mode}`,
    `date=${report.date}`,
    report.dealId ? `deal=${report.dealId}` : null,
    report.limit ? `limit=${report.limit}` : null
  ].filter(Boolean).join(" ");

  const lines = [
    `gz plan status refresh: ${flags}`,
    `всего сделок: ${report.totalDeals}`,
    `найдено в API: ${report.foundInApi}`,
    `без изменений: ${report.unchanged}`,
    `${report.mode === "execute" ? "обновлено" : "будет обновлено"}: ${
      report.mode === "execute"
        ? `${report.updated}${report.limit ? ` (из ${report.toUpdate} по лимиту ${report.limit})` : ""}`
        : `${report.toUpdate} (переходов: ${report.transitionsCount}, синхронизация полей: ${report.syncCount})`
    }`
  ];

  if (report.transitionPairs.length > 0) {
    lines.push(`  реальные переходы (${report.transitionsCount}):`);
    lines.push(...report.transitionPairs.map((pair) => `    ${label(pair.from)} → ${pair.to}: ${pair.count}`));
  }
  if (report.syncPairs.length > 0) {
    lines.push(`  синхронизация второго поля (${report.syncCount}):`);
    lines.push(...report.syncPairs.map((pair) => `    ${label(pair.from)} → ${pair.to}: ${pair.count}`));
  }

  lines.push(
    `не найдено в API: ${report.notFound}`,
    `пропущено: ${report.skipped}`,
    ...report.skippedDowngrade.map(
      (item) => `  пропуск (понижение): сделка ${item.dealId}, план ${item.planNumber}, в CRM «${item.crmStatus}», в API «${item.apiStatus}»`
    ),
    ...report.skippedUnknownStatus.map(
      (item) => `  пропуск (неизвестный статус): сделка ${item.dealId}, план ${item.planNumber}, в CRM «${item.crmStatus}», в API «${item.apiStatus}»`
    ),
    ...report.skippedInvalidPlanNumber.map(
      (item) => `  пропуск (некорректный номер плана): сделка ${item.dealId}, «${item.planNumber}»`
    ),
    `ошибки: ${report.errors.length}`,
    ...report.errors.map((error) => `  ${error.dealId ?? "-"} ${error.planNumber ?? "-"}: ${error.message}`)
  );
  if (report.mode === "dry-run" && report.updates.length > 0) {
    lines.push(`первые ${Math.min(DRY_RUN_PREVIEW_LIMIT, report.updates.length)} изменений (сделка, номер плана, было → стало):`);
    lines.push(
      ...report.updates
        .slice(0, DRY_RUN_PREVIEW_LIMIT)
        .map((update) => `  ${update.dealId}, ${update.planNumber}, ${label(update.from)} → ${update.to}${update.isSync ? " (синхронизация полей)" : ""}`)
    );
  }
  return lines;
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRu(value: string): string {
  return value.trim().toLocaleLowerCase("ru");
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
