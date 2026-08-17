import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { isValidBin } from "./csv.js";
import { filterGzItems } from "./gzItemFilter.js";
import { collectGoszakupRegistryForBins } from "./goszakupRegistryCollector.js";
import { collectGzPlans } from "./goszakupPlanCollector.js";
import type { GoszakupRegistryRecord } from "./registryTypes.js";
import { KzStorage } from "./kzStorage.js";
import type {
  GzPlanExportOptions,
  GzPlanExportResult,
  GzPlanExportRow,
  GoszakupPlanDetail,
  GoszakupPlanListItem,
  PlanDetailCacheStats
} from "./goszakupPlanTypes.js";
import { MONTH_NAMES_RU as MONTH_MAP } from "./goszakupPlanTypes.js";

const BASE_URL = "https://goszakup.gov.kz";

const EXPORT_COLUMNS: Array<{ header: string; key: keyof GzPlanExportRow; width: number }> = [
  { header: "БИН Заказчика", key: "customer_bin", width: 16 },
  { header: "Наименование заказчика", key: "customer_name", width: 46 },
  { header: "Вебсайт", key: "website", width: 28 },
  { header: "e-mail", key: "email", width: 28 },
  { header: "Контактный телефон", key: "phone", width: 22 },
  { header: "Наименование Администратора отчетности", key: "reporting_administrator", width: 36 },
  { header: "Полный адрес", key: "full_address", width: 46 },
  { header: "Руководитель ФИО", key: "director_name", width: 32 },
  { header: "Дата акта, которым утвержден план", key: "plan_act_date", width: 24 },
  { header: "Код товара, работы, услуги (в соответствии с СТРУ)", key: "stru_code", width: 28 },
  { header: "Наименование закупаемых товаров (в соответствии СТРУ)", key: "stru_name", width: 42 },
  { header: "Ссылка на наименование", key: "item_link", width: 52 },
  { header: "Единица измерения", key: "unit", width: 16 },
  { header: "Кол-во", key: "quantity", width: 10 },
  { header: "Цена за ед.", key: "unit_price", width: 16 },
  { header: "Дополнительная характеристика", key: "extra_characteristics", width: 48 },
  { header: "Населённый пункт (КАТО)", key: "keyword", width: 28 },
  { header: "№ пункта плана", key: "plan_list_number", width: 16 },
  { header: "ID пункта (API)", key: "plan_point_id", width: 14 },
  { header: "Планируемый срок", key: "planned_month", width: 16 },
  { header: "Статус", key: "status", width: 18 },
  { header: "Плановая сумма", key: "planned_amount", width: 18 },
  { header: "Способ закупки", key: "method", width: 28 },
  { header: "Ссылка на заказчика", key: "customer_link", width: 52 },
  { header: "Ссылка на пункт плана", key: "plan_link", width: 52 },
  { header: "Краткая характеристика", key: "short_characteristics", width: 48 },
  { header: "Дополнительное описание", key: "extra_description", width: 56 },
  { header: "Место поставки", key: "delivery_address", width: 56 }
];

const HYPERLINK_KEYS = new Set<keyof GzPlanExportRow>(["item_link", "customer_link", "plan_link"]);

export async function exportGzPlansReport(options: GzPlanExportOptions = {}): Promise<GzPlanExportResult> {
  // Safe because exportCollectedPlans re-applies the same minAmount/excludeKeywords
  // filters post-detail (filterPlanRowsWithStats), so the final rows are identical.
  const collectResult = await collectGzPlans({ ...options, prefilterDetails: true });
  const truFilterResult = filterCollectedPlansByTruCode(
    collectResult.items,
    options.includeTruCodePrefixes ?? []
  );
  const databasePath = options.databasePath ?? process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";
  const storage = new KzStorage({ databasePath });

  const cacheStats = collectResult.cacheStats ?? { cacheHit: 0, cacheMiss: 0, fetched: 0, fetchFailed: 0 };
  try {
    return await exportCollectedPlans(
      truFilterResult.items,
      options,
      storage,
      databasePath,
      truFilterResult.droppedByTruCode,
      cacheStats
    );
  } finally {
    storage.close();
  }
}

async function exportCollectedPlans(
  items: Array<GoszakupPlanListItem & { detail: GoszakupPlanDetail | null }>,
  options: GzPlanExportOptions,
  storage: KzStorage,
  databasePath: string,
  droppedByTruCode: number,
  cacheStats: PlanDetailCacheStats
): Promise<GzPlanExportResult> {

  const customerBins = [...new Set(
    items
      .map((item) => item.detail?.customer_bin)
      .filter((bin): bin is string => Boolean(bin && isValidBin(bin)))
  )];

  let registryHits = 0;
  if (!options.skipRegistry && customerBins.length > 0) {
    const profileUrlsByBin = buildRegistryProfileHints(items);
    await collectGoszakupRegistryForBins(customerBins, {
      databasePath,
      forceRefresh: options.forceRegistryRefresh ?? false,
      delayMs: options.delayMs,
      headless: options.headless,
      requireContacts: true,
      requireName: true,
      profileUrlsByBin
    });
  }

  const registryByBin = new Map<string, GoszakupRegistryRecord>();
  for (const bin of customerBins) {
    const record = storage.getGoszakupRegistryByBin(bin);
    if (record) {
      registryByBin.set(bin, record);
      registryHits++;
    }
  }

  if (!options.skipRegistry) {
    assertRegistryCoverage(items, registryByBin);
  }

  const builtRows = items
    .map((item) => buildExportRow(
      item,
      item.detail,
      registryByBin.get(item.detail?.customer_bin ?? "") ?? null,
      { allowMissingCustomerBin: options.skipDetails ?? false }
    ))
    .filter((row): row is GzPlanExportRow => row !== null);
  const filterResult = filterPlanRowsWithStats(builtRows, options.minAmount ?? 0, options.excludeKeywords ?? []);
  const rows = filterResult.items.sort(compareExportRows);
  if (filterResult.droppedBelowMinAmount > 0 || filterResult.droppedByName > 0 || droppedByTruCode > 0) {
    console.log(
      `gz plan export: dropped below_min=${filterResult.droppedBelowMinAmount}`
      + ` stop_list=${filterResult.droppedByName} tru_code=${droppedByTruCode}`
    );
  }

  const xlsxPath = options.outPath ?? defaultOutputPath();
  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Scrape2Lead";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Планы ГЗ");
  sheet.columns = EXPORT_COLUMNS;
  sheet.addRows(rows);
  sheet.getRow(1).font = { bold: true };
  applyHyperlinks(sheet, rows);

  await workbook.xlsx.writeFile(xlsxPath);

  return {
    xlsxPath,
    rows: rows.length,
    customers: customerBins.length,
    registryHits,
    cacheStats
  };
}

type CollectedPlanItem = GoszakupPlanListItem & { detail: GoszakupPlanDetail | null };

export function buildRegistryProfileHints(items: CollectedPlanItem[]): Map<string, string> {
  const hints = new Map<string, string>();
  for (const item of items) {
    const bin = item.detail?.customer_bin;
    if (!bin || !isValidBin(bin) || !item.customer_url) continue;
    const profileUrl = normalizeSupplierProfileUrl(item.customer_url);
    if (!profileUrl) continue;

    const existing = hints.get(bin);
    if (existing && existing !== profileUrl) {
      throw new Error(`registry profile conflict for BIN ${bin}: ${existing} vs ${profileUrl}`);
    }
    hints.set(bin, profileUrl);
  }
  return hints;
}

export function assertRegistryCoverage(
  items: CollectedPlanItem[],
  registryByBin: ReadonlyMap<string, GoszakupRegistryRecord>
): void {
  const planIdsByBin = new Map<string, string[]>();
  for (const item of items) {
    const bin = item.detail?.customer_bin;
    if (!bin || !isValidBin(bin)) continue;
    const planIds = planIdsByBin.get(bin) ?? [];
    if (!planIds.includes(item.plan_point_id)) planIds.push(item.plan_point_id);
    planIdsByBin.set(bin, planIds);
  }

  const failures: string[] = [];
  for (const [bin, planIds] of planIdsByBin) {
    const record = registryByBin.get(bin);
    if (!record || record.bin !== bin || !record.name_ru?.trim()) {
      failures.push(`BIN ${bin} (plans: ${planIds.join(", ")})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`registry preflight failed: ${failures.join("; ")}`);
  }
}

function normalizeSupplierProfileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "goszakup.gov.kz" && url.hostname !== "www.goszakup.gov.kz") return null;
    const match = url.pathname.match(/^\/(ru|kz)\/registry\/show_supplier\/(\d+)\/?$/);
    if (!match) return null;
    return `https://goszakup.gov.kz/${match[1]}/registry/show_supplier/${match[2]}`;
  } catch {
    return null;
  }
}

export function buildExportRow(
  listItem: GoszakupPlanListItem,
  detail: GoszakupPlanDetail | null,
  registry: GoszakupRegistryRecord | null,
  options: { allowMissingCustomerBin?: boolean } = {}
): GzPlanExportRow | null {
  const customerBin = detail?.customer_bin;
  if ((!customerBin || !isValidBin(customerBin)) && !options.allowMissingCustomerBin) {
    console.warn(`gz plan export: skip plan ${listItem.plan_point_id} — missing customer BIN`);
    return null;
  }

  const extraParts = [detail?.desc_ru, detail?.extra_desc_ru].filter(Boolean);
  const fullAddress = [
    registry?.full_address_ru ?? registry?.legal_address,
    registry?.location_address,
    detail?.delivery_address
  ].filter(Boolean).join("; ") || "";

  const planLink = listItem.detail_url ?? "";
  const customerLink = listItem.customer_url ?? buildRegistryCustomerUrl(registry);

  return {
    customer_bin: customerBin && isValidBin(customerBin) ? customerBin : "",
    customer_name: registry?.name_ru ?? listItem.customer_name ?? detail?.customer_name ?? "",
    website: registry?.website ?? "",
    email: registry?.email ?? "",
    phone: registry?.phone ?? "",
    reporting_administrator: detail?.abp_name ?? registry?.reporting_administrator ?? detail?.ref_abp_code ?? "",
    full_address: fullAddress,
    director_name: registry?.director_name ?? "",
    plan_act_date: detail?.date_approved ?? "",
    stru_code: detail?.ref_enstru_code ?? "",
    stru_name: detail?.name_ru ?? listItem.item_name ?? "",
    item_link: planLink,
    unit: listItem.unit ?? "",
    quantity: listItem.quantity ?? "",
    unit_price: listItem.unit_price ?? "",
    extra_characteristics: extraParts.join(" | "),
    keyword: listItem.keyword,
    plan_list_number: listItem.plan_list_number ?? listItem.plan_point_id,
    plan_point_id: listItem.plan_point_id,
    planned_month: listItem.planned_month ?? "",
    status: listItem.status ?? "",
    planned_amount: listItem.planned_amount ?? "",
    method: listItem.method ?? "",
    customer_link: customerLink,
    plan_link: planLink,
    short_characteristics: detail?.desc_ru ?? "",
    extra_description: detail?.extra_desc_ru ?? "",
    delivery_address: detail?.delivery_address ?? ""
  };
}

function buildRegistryCustomerUrl(registry: GoszakupRegistryRecord | null): string {
  if (!registry?.participant_id) return "";
  return `${BASE_URL}/ru/registry/show_supplier/${registry.participant_id}`;
}

function applyHyperlinks(sheet: ExcelJS.Worksheet, rows: GzPlanExportRow[]): void {
  const columnIndexByKey = new Map<keyof GzPlanExportRow, number>();
  for (const column of EXPORT_COLUMNS) {
    columnIndexByKey.set(column.key, EXPORT_COLUMNS.indexOf(column) + 1);
  }

  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(rowIndex + 2);
    for (const key of HYPERLINK_KEYS) {
      const url = row[key];
      if (!url) continue;
      const colIndex = columnIndexByKey.get(key);
      if (!colIndex) continue;
      excelRow.getCell(colIndex).value = { text: url, hyperlink: url };
    }
  });
}

function compareExportRows(a: GzPlanExportRow, b: GzPlanExportRow): number {
  const monthA = MONTH_MAP[a.planned_month.toLocaleLowerCase("ru")] ?? 99;
  const monthB = MONTH_MAP[b.planned_month.toLocaleLowerCase("ru")] ?? 99;
  if (monthA !== monthB) return monthA - monthB;

  const keywordCmp = a.keyword.localeCompare(b.keyword, "ru");
  if (keywordCmp !== 0) return keywordCmp;

  const amountA = parseAmount(a.planned_amount);
  const amountB = parseAmount(b.planned_amount);
  return amountB - amountA;
}

/**
 * Drops plan rows whose planned amount is below `minAmount` (when > 0) or whose
 * item name matches the stop-list. Applied at export time so junk never reaches
 * the xlsx / Bitrix.
 */
export function filterPlanRows(
  rows: GzPlanExportRow[],
  minAmount: number,
  excludeKeywords: string[],
  includeTruCodePrefixes: string[] = []
): GzPlanExportRow[] {
  return filterPlanRowsWithStats(rows, minAmount, excludeKeywords, includeTruCodePrefixes).items;
}

function filterPlanRowsWithStats(
  rows: GzPlanExportRow[],
  minAmount: number,
  excludeKeywords: string[],
  includeTruCodePrefixes: string[] = []
) {
  const baseResult = filterGzItems(rows, {
    minAmount, excludeKeywords,
    getAmount: (row) => parseAmount(row.planned_amount),
    getName: (row) => row.stru_name
  });

  const truFilterResult = filterByTruCode(
    baseResult.items,
    includeTruCodePrefixes,
    (row) => row.stru_code
  );
  return { ...baseResult, ...truFilterResult };
}

type CollectedPlan = GoszakupPlanListItem & { detail: GoszakupPlanDetail | null };

export function filterCollectedPlansByTruCode(
  items: readonly CollectedPlan[],
  includeTruCodePrefixes: readonly string[]
): { items: CollectedPlan[]; droppedByTruCode: number } {
  return filterByTruCode(items, includeTruCodePrefixes, (item) => item.detail?.ref_enstru_code ?? "");
}

function filterByTruCode<T>(
  items: readonly T[],
  includeTruCodePrefixes: readonly string[],
  getTruCode: (item: T) => string
): { items: T[]; droppedByTruCode: number } {
  const prefixes = includeTruCodePrefixes.map((prefix) => prefix.trim()).filter(Boolean);
  if (prefixes.length === 0) return { items: [...items], droppedByTruCode: 0 };

  const kept = items.filter((item) => prefixes.some((prefix) => getTruCode(item).trim().startsWith(prefix)));
  return { items: kept, droppedByTruCode: items.length - kept.length };
}

function parseAmount(value: string): number {
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function defaultOutputPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join("exports", `gz-plans-${date}.xlsx`);
}
