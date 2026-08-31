import type { GoszakupPlanDetail, GoszakupPlanListItem } from "./goszakupPlanTypes.js";
import { extractGzPlanPointIdFromUrl } from "./gzPlanIdentity.js";
import { parseGoszakupPagination } from "./goszakupHtmlParser.js";
import { GZ_PORTAL_ORIGIN } from "./goszakupOrigin.js";

export { parseGoszakupPagination };

const BASE_URL = GZ_PORTAL_ORIGIN;

export function buildPlanSearchUrl(options: {
  keyword?: string;
  katoCode?: string;
  year: number;
  months: number[];
  /** Optional; omit in collector — goszakup serves a maintenance page when filter[status][] is present. */
  statusIds?: number[];
  /** Singular filter used by Goszakup for KATO plan searches. */
  statusId?: number;
  recordsPerPage?: number;
}): string {
  const hasKeyword = Boolean(options.keyword?.trim());
  const hasKato = Boolean(options.katoCode?.trim());
  if (hasKeyword === hasKato) {
    throw new Error("Plan search requires exactly one keyword or KATO code");
  }

  const params = new URLSearchParams();
  if (hasKeyword) params.set("filter[name]", options.keyword!.trim());
  if (hasKato) params.set("filter[kato]", options.katoCode!.trim());
  params.append("filter[year][]", String(options.year));
  for (const month of options.months) {
    params.append("filter[month][]", String(month));
  }
  for (const statusId of options.statusIds ?? []) {
    params.append("filter[status][]", String(statusId));
  }
  if (options.statusId !== undefined) {
    params.set("filter[status]", String(options.statusId));
  }
  params.set("count_record", String(options.recordsPerPage ?? 50));
  return `${BASE_URL}/ru/registry/plan?${params.toString()}`;
}

export function matchesPlanStatus(status: string | null, allowedNames: string[]): boolean {
  if (allowedNames.length === 0) return true;
  if (!status) return false;
  const normalized = status.trim().toLocaleLowerCase("ru");
  return allowedNames.some((name) => name.trim().toLocaleLowerCase("ru") === normalized);
}

export function parseGoszakupPlanSearchHtml(html: string, keyword: string): GoszakupPlanListItem[] {
  const rows = extractPlanTableRows(html);
  const items: GoszakupPlanListItem[] = [];

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 8) continue;

    const detailUrl = extractPlanDetailUrl(row);
    const planPointId = extractPlanPointIdFromUrl(detailUrl) ?? extractPlanPointId(row, cells[0]);
    if (!planPointId) continue;

    const planListNumber = extractPlanListNumber(cells[0]);
    const resolvedDetailUrl = detailUrl ?? `${BASE_URL}/ru/registry/show_plan/${planListNumber ?? planPointId}`;

    items.push({
      plan_point_id: planPointId,
      plan_list_number: planListNumber,
      customer_name: cleanText(cells[1]) || null,
      customer_url: extractCustomerUrl(row),
      item_name: cleanText(cells[2]) || null,
      method: cleanText(cells[3]) || null,
      unit: cleanText(cells[4]) || null,
      quantity: cleanText(cells[5]) || null,
      unit_price: (extractStrongText(cells[6]) ?? cleanText(cells[6])) || null,
      planned_amount: (extractStrongText(cells[7]) ?? cleanText(cells[7])) || null,
      planned_month: cells.length > 8 ? cleanText(cells[8]) || null : null,
      status: cells.length > 9 ? cleanText(cells[9]) || null : null,
      detail_url: resolvedDetailUrl,
      keyword
    });
  }

  return items;
}

export function parseGoszakupPlanDetailHtml(html: string, planPointId: string): GoszakupPlanDetail | null {
  if (/технические работы/i.test(html)) {
    return null;
  }

  const fields = extractProfileFields(html);
  const customerBin = findFieldValue(fields, [
    "БИН заказчика",
    "БИН/ИИН заказчика",
    "БИН участника",
    "БИН"
  ]) ?? extractBinFromHtml(html);

  const struCode = findFieldValue(fields, [
    "Код товара, работы, услуги (в соответствии с СТРУ)",
    "Код товара, работы или услуги (в соответствии с СТРУ)",
    "Код товара, работы, услуги (в соответствии с КТРУ)"
  ]) ?? extractControlValue(html, ["ref_enstru_code"]);

  const struName = findFieldValue(fields, [
    "Наименование закупаемых товаров, работ, услуг на русском языке (в соответствии с СТРУ)",
    "Наименование товара, работы, услуги",
    "Наименование на русском языке"
  ]) ?? extractControlValue(html, ["name_ru", "enstru-name"]);

  const descRu = findFieldValue(fields, [
    "Краткая характеристика (описание) товаров, работ и услуг на русском языке (в соответствии с СТРУ)",
    "Краткая характеристика на русском языке"
  ]) ?? extractControlValue(html, ["desc_ru"]);

  const extraDescRu = findFieldValue(fields, [
    "Дополнительная характеристика (описание) товаров, работ и услуг (на русском языке)",
    "Дополнительное описание на русском языке"
  ]) ?? extractControlValue(html, ["extra_desc_ru"]);

  const actDate = findFieldValue(fields, [
    "Дата акта, которым утвержден план",
    "Дата приказа",
    "Дата утверждения"
  ]);

  const abpName = findFieldValue(fields, [
    "Наименование администратора(ов) отчетности",
    "Наименование Администратора отчетности",
    "Администратор бюджетной программы",
    "Администратор отчетности"
  ]);

  const abpCode = findFieldValue(fields, [
    "Код администратора бюджетной программы"
  ]);

  const deliveryAddress = findFieldValue(fields, [
    "Полный адрес поставки на русском языке",
    "Место поставки",
    "Полный адрес"
  ]) ?? extractSupplyAddresses(html);

  const customerName = findFieldValue(fields, [
    "Наименование заказчика",
    "Заказчик"
  ]);

  const planActNumber = findFieldValue(fields, [
    "Номер акта",
    "Номер акта, которым утвержден план"
  ]);

  if (!customerBin && !struCode && !struName && !customerName) {
    return null;
  }

  return {
    plan_point_id: planPointId,
    customer_bin: normalizeBin(customerBin),
    customer_name: nullable(customerName),
    name_ru: nullable(struName),
    ref_enstru_code: nullable(struCode),
    desc_ru: nullable(descRu),
    extra_desc_ru: nullable(extraDescRu),
    date_approved: normalizeDate(actDate),
    ref_abp_code: nullable(abpCode),
    abp_name: nullable(abpName),
    delivery_address: nullable(deliveryAddress),
    plan_act_number: nullable(planActNumber)
  };
}

export function matchesKeyword(itemName: string | null, keyword: string): boolean {
  if (!itemName) return false;
  return itemName.toLocaleLowerCase("ru").includes(keyword.toLocaleLowerCase("ru"));
}

function extractPlanTableRows(html: string): string[] {
  const tableRegex = /<table[^>]*id="search-result"[^>]*>([\s\S]*?)<\/table>/i;
  const tableMatch = html.match(tableRegex);
  if (!tableMatch) return [];

  const tbodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const body = tbodyMatch ? tbodyMatch[1] : tableMatch[1];

  const rows: string[] = [];
  const rowRegex = /<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(body)) !== null) {
    if (match[1].includes("dataTables_empty")) continue;
    rows.push(match[1]);
  }
  return rows;
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    cells.push(match[1]);
  }
  return cells;
}

function extractPlanListNumber(firstCell: string): string | null {
  const cleaned = cleanText(firstCell);
  return cleaned && /^\d+$/.test(cleaned) ? cleaned : null;
}

function extractPlanPointId(rowHtml: string, firstCell: string): string | null {
  const cleaned = extractPlanListNumber(firstCell);
  return cleaned;
}

function extractPlanPointIdFromUrl(detailUrl: string | null): string | null {
  return extractGzPlanPointIdFromUrl(detailUrl);
}

export function extractCustomerUrl(rowHtml: string): string | null {
  const match = rowHtml.match(/href="([^"]*\/registry\/show_supplier\/\d+[^"]*)"/i);
  if (!match) return null;
  const href = decodeEntities(match[1]);
  if (href.startsWith("http")) return href;
  return `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
}

function extractPlanDetailUrl(rowHtml: string): string | null {
  const match = rowHtml.match(/href="([^"]*\/registry\/show_plan\/[^"]+)"/i);
  if (!match) return null;
  const href = decodeEntities(match[1]);
  if (href.startsWith("http")) return href;
  return `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
}

interface ProfileField {
  label: string;
  value: string;
}

function extractProfileFields(html: string): ProfileField[] {
  const fields: ProfileField[] = [];

  const divCellRegex = /<div\s+class=["']divTableCell["'][^>]*>([\s\S]*?)<\/div>/gi;
  const cells: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = divCellRegex.exec(html)) !== null) {
    cells.push(cleanHtmlText(match[1]));
  }
  for (let i = 0; i < cells.length - 1; i += 2) {
    fields.push({ label: cells[i], value: cells[i + 1] ?? "" });
  }

  const thTdRegex = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  while ((match = thTdRegex.exec(html)) !== null) {
    fields.push({ label: cleanHtmlText(match[1]), value: cleanHtmlText(match[2]) });
  }

  const labelValueRegex = /<div[^>]*class=["'][^"']*label[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=["'][^"']*value[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  while ((match = labelValueRegex.exec(html)) !== null) {
    fields.push({ label: cleanHtmlText(match[1]), value: cleanHtmlText(match[2]) });
  }

  const dtDdRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  while ((match = dtDdRegex.exec(html)) !== null) {
    fields.push({ label: cleanHtmlText(match[1]), value: cleanHtmlText(match[2]) });
  }

  return fields;
}

function findFieldValue(fields: ProfileField[], labels: string[]): string | null {
  for (const field of fields) {
    const normalizedLabel = normalizeLabel(field.label);
    for (const label of labels) {
      if (normalizedLabel === normalizeLabel(label) || normalizedLabel.includes(normalizeLabel(label))) {
        return field.value || null;
      }
    }
  }
  return null;
}

function extractBinFromHtml(html: string): string | null {
  const labeled = html.match(/БИН[^<]{0,40}<\/[^>]+>\s*<[^>]+>\s*(\d{12})/i);
  if (labeled) return labeled[1];
  const generic = html.match(/\b(\d{12})\b/);
  return generic?.[1] ?? null;
}

function normalizeBin(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const dotMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotMatch) return `${dotMatch[3]}-${dotMatch[2]}-${dotMatch[1]}`;
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  return trimmed;
}

function normalizeLabel(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanHtmlText(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function cleanText(input: string): string {
  return cleanHtmlText(input);
}

function extractStrongText(input: string): string | null {
  const match = input.match(/<strong>([^<]+)<\/strong>/);
  return match ? cleanHtmlText(match[1]) : null;
}

function extractControlValue(html: string, namesOrIds: string[]): string | null {
  for (const nameOrId of namesOrIds) {
    const escaped = escapeRegex(nameOrId);
    const textareaRegex = new RegExp(
      `<textarea[^>]*(?:name|id)=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/textarea>`,
      "i"
    );
    const textareaMatch = html.match(textareaRegex);
    if (textareaMatch) return cleanHtmlText(textareaMatch[1]);

    const inputRegex = new RegExp(`<input[^>]*(?:name|id)=["']${escaped}["'][^>]*>`, "i");
    const inputMatch = html.match(inputRegex);
    if (!inputMatch) continue;

    const valueMatch = inputMatch[0].match(/\bvalue=["']([^"']*)["']/i);
    if (valueMatch) return cleanHtmlText(valueMatch[1]);
  }

  return null;
}

function extractSupplyAddresses(html: string): string | null {
  const addresses: string[] = [];
  const regex = /<textarea[^>]*name=["'][^"']*\[supply_address\]["'][^>]*>([\s\S]*?)<\/textarea>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const value = cleanHtmlText(match[1]);
    if (value) addresses.push(value);
  }

  return addresses.length > 0 ? [...new Set(addresses)].join("; ") : null;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

function nullable(value: string | null): string | null {
  return value && value.trim() ? value.trim() : null;
}
