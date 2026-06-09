import type { LegalStatus, StatGovRecord } from "./tenderTypes.js";

const FIELD_LABELS = {
  bin: "БИН",
  name: "Наименование",
  registrationDate: "Дата регистрации",
  oked: "Основной код ОКЭД",
  okedName: "Наименование вида экономической деятельности",
  address: "Юридический адрес",
  director: "Фамилия, имя, отчество руководителя",
  krpCode: "Код КРП (с учетом филиалов)",
  krpName: "Наименование КРП",
  kfsCode: "Код КФС",
  kfsName: "Наименование КФС",
  sectorCode: "Код сектора экономики",
  sectorName: "Наименование сектора экономики"
} as const;

const STATUS_LABELS = ["Статус", "Состояние", "Статус юрлица", "Состояние юрлица"];

export function extractStatGovField(html: string, label: string): string | null {
  const cells = extractDivTableCells(html);
  for (let i = 0; i < cells.length - 1; i++) {
    if (normalizeLabel(cells[i]) === normalizeLabel(label)) {
      return cells[i + 1] || null;
    }
  }
  return null;
}

export function parseStatGovHtml(html: string): StatGovRecord | null {
  const bin = extractStatGovField(html, FIELD_LABELS.bin);
  if (!bin) return null;

  const statusText = STATUS_LABELS
    .map((label) => extractStatGovField(html, label))
    .find((value): value is string => Boolean(value));

  return {
    bin,
    name: extractStatGovField(html, FIELD_LABELS.name) ?? "",
    registration_date: normalizeDateToIso(extractStatGovField(html, FIELD_LABELS.registrationDate)),
    oked: nullable(extractStatGovField(html, FIELD_LABELS.oked)),
    oked_name: nullable(extractStatGovField(html, FIELD_LABELS.okedName)),
    address: nullable(extractStatGovField(html, FIELD_LABELS.address)),
    director: nullable(extractStatGovField(html, FIELD_LABELS.director)),
    legal_status: mapLegalStatus(statusText),
    krp_code: nullable(extractStatGovField(html, FIELD_LABELS.krpCode)),
    krp_name: nullable(extractStatGovField(html, FIELD_LABELS.krpName)),
    kfs_code: nullable(extractStatGovField(html, FIELD_LABELS.kfsCode)),
    kfs_name: nullable(extractStatGovField(html, FIELD_LABELS.kfsName)),
    sector_code: nullable(extractStatGovField(html, FIELD_LABELS.sectorCode)),
    sector_name: nullable(extractStatGovField(html, FIELD_LABELS.sectorName))
  };
}

export const STAT_GOV_BIN_NOT_FOUND_ERROR = "stat.gov: BIN not found in BNS database";

export function isStatGovBinNotFound(html: string): boolean {
  const text = cleanHtmlText(html).toLowerCase();
  return text.includes("данные, удовлетворяющие вашему запросу, не найдены");
}

export function getStatGovFetchFailure(html: string): string {
  if (isStatGovBinNotFound(html)) return STAT_GOV_BIN_NOT_FOUND_ERROR;
  return "record not found in stat.gov HTML";
}

export function mapLegalStatus(input: string | null | undefined): LegalStatus {
  if (!input) return "unknown";
  const value = input.toLowerCase();
  if (value.includes("реорганиза")) return "reorganizing";
  if (value.includes("ликвид") || value.includes("прекращ")) return "liquidated";
  if (value.includes("недейств")) return "inactive";
  if (value.includes("действ") || value.includes("зарегистр")) return "active";
  return "unknown";
}

function extractDivTableCells(html: string): string[] {
  const cells: string[] = [];
  const regex = /<div\s+class=["']divTableCell["'][^>]*>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    cells.push(cleanHtmlText(match[1]));
  }
  return cells;
}

function cleanHtmlText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

function normalizeLabel(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function nullable(value: string | null): string | null {
  return value && value.trim() ? value.trim() : null;
}

function normalizeDateToIso(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return value;
  return `${match[3]}-${match[2]}-${match[1]}`;
}
