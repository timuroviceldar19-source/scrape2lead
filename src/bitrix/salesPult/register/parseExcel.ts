import type ExcelJS from "exceljs";
import type { RegisterRow, ProductGroup } from "./types.js";

const PRODUCT_GROUP: Record<string, [ProductGroup, string]> = {
  "панель": ["ИП", "Интерактивные панели"],
  "мульт система": ["ИП", "Мультимедийные системы"],
  "мульт комплекс": ["ИП", "Мультимедийные системы"],
  "моноблок": ["КТ", "Моноблоки"],
  "пк": ["КТ", "Компьютеры"],
  "компьютер": ["КТ", "Компьютеры"],
  "сист блок": ["КТ", "Компьютеры"],
  "ноутбук": ["КТ", "Ноутбуки"],
  "мфу": ["КТ", "МФУ и принтеры"],
  "принтер": ["КТ", "МФУ и принтеры"],
  "монитор": ["КТ", "Мониторы"]
};

const CHANNELS: Record<string, string> = {
  "ом": "Электронный магазин",
  "зцп": "Запрос ценовых предложений",
  "из 1 ист": "Из одного источника",
  "ок": "Открытый конкурс",
  "b2b": "B2B, вне портала"
};

export function classifyProduct(product: string): [ProductGroup, string] {
  const norm = product.toLowerCase().trim();
  for (const [key, val] of Object.entries(PRODUCT_GROUP)) {
    if (norm === key || norm.startsWith(key) || norm.includes(key)) {
      return val;
    }
  }
  return ["Прочее", "Прочее"];
}

export function normalizeChannel(type: string): string {
  const norm = type.toLowerCase().trim().replace(/\s+/g, " ");
  return CHANNELS[norm] ?? type;
}

function getCellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && "result" in v) {
    return (v as { result: unknown }).result;
  }
  return v;
}

function extractDateFromFilename(fileName?: string): { asOf: string; month: string } {
  if (!fileName) {
    const today = new Date().toISOString().slice(0, 10);
    return { asOf: today, month: today.slice(0, 7) };
  }
  const m = fileName.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return { asOf: `${year}-${month}-${day}`, month: `${year}-${month}` };
  }
  const today = new Date().toISOString().slice(0, 10);
  return { asOf: today, month: today.slice(0, 7) };
}

function parseCellDate(val: unknown, defaultYearMonth: string): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (!s || s === "0") return null;
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const dmMatch = s.match(/^(\d{1,2})[.](\d{1,2})(?:[.](\d{2,4}))?$/);
  if (dmMatch) {
    const day = dmMatch[1].padStart(2, "0");
    const month = dmMatch[2].padStart(2, "0");
    const year = dmMatch[3] ? (dmMatch[3].length === 2 ? `20${dmMatch[3]}` : dmMatch[3]) : defaultYearMonth.slice(0, 4);
    return `${year}-${month}-${day}`;
  }
  return null;
}

export interface ParsedRegisterResult {
  rows: RegisterRow[];
  plans: Record<string, number>;
  asOf: string;
  month: string;
}

export function parseRegisterWorkbook(
  workbook: ExcelJS.Workbook,
  fileName?: string
): ParsedRegisterResult {
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error("В файле Excel нет листов");

  const { asOf, month } = extractDateFromFilename(fileName);

  // 1. Locate header row
  let headerRowNum = -1;
  const colMap = new Map<string, number>();

  for (let r = 1; r <= Math.min(25, ws.rowCount); r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      const val = String(getCellValue(row.getCell(c)) ?? "").trim().toLowerCase();
      if (val.includes("дата подписания договора")) {
        headerRowNum = r;
        break;
      }
    }
    if (headerRowNum !== -1) {
      for (let c = 1; c <= row.cellCount; c++) {
        const val = String(getCellValue(row.getCell(c)) ?? "").trim().toLowerCase();
        if (val) colMap.set(val, c);
      }
      break;
    }
  }

  if (headerRowNum === -1) {
    throw new Error("Не найдена строка заголовков с «Дата подписания договора»");
  }

  const findCol = (...names: string[]): number | undefined => {
    for (const n of names) {
      const low = n.toLowerCase();
      for (const [colName, idx] of colMap.entries()) {
        if (colName === low || colName.includes(low)) return idx;
      }
    }
    return undefined;
  };

  const colDate = findCol("дата подписания договора");
  const colType = findCol("тип продажи");
  const colCustomer = findCol("контрагент");
  const colQty = findCol("кол-во", "количество");
  const colProduct = findCol("товар");
  const colCost = findCol("сумма без ндс (закуп)", "сумма без ндс");
  const colSale = findCol("сумма продажи без ндс");
  const colPortal = findCol("сумма договора с портала без ндс");
  const colVal = findCol("итого вал", "вал");
  const colBonusMop = findCol("бонус моп");
  const colBonusRop = findCol("бонус роп");
  const colManager = findCol("менеджер");

  const rows: RegisterRow[] = [];

  for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const dateVal = colDate ? getCellValue(row.getCell(colDate)) : null;
    const parsedDate = parseCellDate(dateVal, month);
    if (!parsedDate) continue;

    const manager = String(colManager ? getCellValue(row.getCell(colManager)) ?? "" : "").trim();
    const customer = String(colCustomer ? getCellValue(row.getCell(colCustomer)) ?? "" : "").trim();
    const type = String(colType ? getCellValue(row.getCell(colType)) ?? "" : "").trim();
    const product = String(colProduct ? getCellValue(row.getCell(colProduct)) ?? "" : "").trim();
    const qty = Number(colQty ? getCellValue(row.getCell(colQty)) : 0) || 0;
    const cost = Number(colCost ? getCellValue(row.getCell(colCost)) : 0) || 0;
    const sale = Number(colSale ? getCellValue(row.getCell(colSale)) : 0) || 0;
    const portal = Number(colPortal ? getCellValue(row.getCell(colPortal)) : 0) || sale;
    const val = Number(colVal ? getCellValue(row.getCell(colVal)) : 0) || 0;
    const bonusMop = Number(colBonusMop ? getCellValue(row.getCell(colBonusMop)) : 0) || 0;
    const bonusRop = Number(colBonusRop ? getCellValue(row.getCell(colBonusRop)) : 0) || 0;

    const [group, kind] = classifyProduct(product);
    const channel = normalizeChannel(type);

    rows.push({
      date: parsedDate,
      type,
      customer,
      qty,
      product,
      cost,
      extras: 0,
      sale,
      portal,
      val,
      bonusMop,
      bonusRop,
      manager,
      note: null,
      group,
      kind,
      channel
    });
  }

  // 2. Locate summary table with plans
  const plans: Record<string, number> = {};
  let summaryHeaderRowNum = -1;
  let summaryColMgr = -1;
  let summaryColPlan = -1;

  for (let r = headerRowNum + rows.length; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      const val = String(getCellValue(row.getCell(c)) ?? "").trim().toLowerCase();
      if (val === "план на месяц") {
        summaryHeaderRowNum = r;
        summaryColPlan = c;
        break;
      }
    }
    if (summaryHeaderRowNum !== -1) {
      for (let c = 1; c <= row.cellCount; c++) {
        const val = String(getCellValue(row.getCell(c)) ?? "").trim().toLowerCase();
        if (val === "менеджер") summaryColMgr = c;
      }
      break;
    }
  }

  if (summaryHeaderRowNum !== -1 && summaryColMgr !== -1 && summaryColPlan !== -1) {
    for (let r = summaryHeaderRowNum + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const mgr = String(getCellValue(row.getCell(summaryColMgr)) ?? "").trim();
      if (!mgr) break;
      const planVal = Number(getCellValue(row.getCell(summaryColPlan))) || 0;
      plans[mgr] = planVal;
    }
  }

  return { rows, plans, asOf, month };
}
