import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { isValidBin } from "./csv.js";
import { isExcludedByName } from "./gzItemFilter.js";
import { collectGoszakupRegistryForBins } from "./goszakupRegistryCollector.js";
import { collectGzPlans } from "./goszakupPlanCollector.js";
import type { GoszakupRegistryRecord } from "./registryTypes.js";
import { KzStorage } from "./kzStorage.js";
import type {
  GzPlanExportOptions,
  GzPlanExportResult,
  GzPlanExportRow,
  GoszakupPlanDetail,
  GoszakupPlanListItem
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
  { header: "Ключевое слово", key: "keyword", width: 28 },
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
  const collectResult = await collectGzPlans(options);
  const databasePath = options.databasePath ?? process.env.KZ_DATABASE_PATH ?? "data/scrape2lead.db";
  const storage = new KzStorage({ databasePath });

  const customerBins = [...new Set(
    collectResult.items
      .map((item) => item.detail?.customer_bin)
      .filter((bin): bin is string => Boolean(bin && isValidBin(bin)))
  )];

  let registryHits = 0;
  if (!options.skipRegistry && customerBins.length > 0) {
    await collectGoszakupRegistryForBins(customerBins, {
      databasePath,
      forceRefresh: options.forceRegistryRefresh ?? false,
      delayMs: options.delayMs,
      headless: options.headless,
      requireContacts: true
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

  const builtRows = collectResult.items
    .map((item) => buildExportRow(item, item.detail, registryByBin.get(item.detail?.customer_bin ?? "") ?? null))
    .filter((row): row is GzPlanExportRow => row !== null);
  const rows = filterPlanRows(builtRows, options.minAmount ?? 0, options.excludeKeywords ?? [])
    .sort(compareExportRows);
  const dropped = builtRows.length - rows.length;
  if (dropped > 0) {
    console.log(`gz plan export: dropped ${dropped} rows below min or in stop-list`);
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

  storage.close();

  return {
    xlsxPath,
    rows: rows.length,
    customers: customerBins.length,
    registryHits
  };
}

export function buildExportRow(
  listItem: GoszakupPlanListItem,
  detail: GoszakupPlanDetail | null,
  registry: GoszakupRegistryRecord | null
): GzPlanExportRow | null {
  const customerBin = detail?.customer_bin;
  if (!customerBin || !isValidBin(customerBin)) {
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
    customer_bin: customerBin,
    customer_name: listItem.customer_name ?? detail?.customer_name ?? registry?.name_ru ?? "",
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
  excludeKeywords: string[]
): GzPlanExportRow[] {
  return rows.filter((row) => {
    if (minAmount > 0 && parseAmount(row.planned_amount) < minAmount) return false;
    if (isExcludedByName(row.stru_name, excludeKeywords)) return false;
    return true;
  });
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
