// Разбор 1С-выгрузки «Отчет о реализации товаров (услуг)» через @e965/xlsx.
// Поддерживает оба разреза:
//   - client-tmc: Контрагент -> Номенклатурная группа -> Номенклатура
//   - tmc-client: Номенклатурная группа -> Номенклатура -> Контрагент
// Умеет автоматически строить второй разрез, если загружен только один файл.
// В сообщениях об ошибках нет названий компаний, клиентов и сумм (лог Actions публичный).

import * as XLSX from "@e965/xlsx";
import { labelKey } from "./parseReport.js";
import type {
  RealizationKind,
  RealizationMetrics,
  RealizationNode,
  RealizationReport
} from "./realizationTypes.js";

export class RealizationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealizationParseError";
  }
}

const UNGROUPED_LABEL = "Без группы";

const MONTHS_NOM_RE = /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*\s+\d{4}/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/\s+/g, "").replace(",", ".");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function cleanText(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function emptyMetrics(hasProfit: boolean): RealizationMetrics {
  return hasProfit
    ? { qtySale: 0, qtyReturn: 0, qtyNet: 0, sumSale: 0, sumReturn: 0, sumNet: 0, excise: 0, vat: 0, sumNoTax: 0, cost: 0, profit: 0 }
    : { qtySale: 0, qtyReturn: 0, qtyNet: 0, sumSale: 0, sumReturn: 0, sumNet: 0, excise: 0, vat: 0, sumNoTax: 0 };
}

function addMetrics(acc: RealizationMetrics, m: RealizationMetrics): RealizationMetrics {
  const next: RealizationMetrics = {
    qtySale: round2(acc.qtySale + m.qtySale),
    qtyReturn: round2(acc.qtyReturn + m.qtyReturn),
    qtyNet: round2(acc.qtyNet + m.qtyNet),
    sumSale: round2(acc.sumSale + m.sumSale),
    sumReturn: round2(acc.sumReturn + m.sumReturn),
    sumNet: round2(acc.sumNet + m.sumNet),
    excise: round2(acc.excise + m.excise),
    vat: round2(acc.vat + m.vat),
    sumNoTax: round2(acc.sumNoTax + m.sumNoTax)
  };
  if (acc.cost !== undefined || m.cost !== undefined) next.cost = round2((acc.cost ?? 0) + (m.cost ?? 0));
  if (acc.profit !== undefined || m.profit !== undefined) next.profit = round2((acc.profit ?? 0) + (m.profit ?? 0));
  return next;
}

interface ColumnMap {
  qtySale: number;
  qtyReturn: number;
  qtyNet: number;
  sumSale: number;
  sumReturn: number;
  sumNet: number;
  excise: number;
  vat: number;
  sumNoTax: number;
  cost: number;
  profit: number;
}

function detectColumns(headerRow: unknown[]): ColumnMap {
  const cols: ColumnMap = {
    qtySale: -1,
    qtyReturn: -1,
    qtyNet: -1,
    sumSale: -1,
    sumReturn: -1,
    sumNet: -1,
    excise: -1,
    vat: -1,
    sumNoTax: -1,
    cost: -1,
    profit: -1
  };

  for (let c = 1; c < headerRow.length; c++) {
    const k = labelKey(cleanText(headerRow[c]));
    if (!k) continue;
    if (k.includes("количество реализации") && k.includes("возврат")) cols.qtyNet = c;
    else if (k.includes("количество реализации")) cols.qtySale = c;
    else if (k.includes("количество возврат")) cols.qtyReturn = c;
    else if (k.includes("сумма реализации") && k.includes("возврат")) cols.sumNet = c;
    else if (k.includes("сумма реализации")) cols.sumSale = c;
    else if (k.includes("сумма возврат")) cols.sumReturn = c;
    else if (k.includes("акциз")) cols.excise = c;
    else if (k.includes("ндс") && k.includes("сумма")) cols.vat = c;
    else if (k.includes("без налогов")) cols.sumNoTax = c;
    else if (k.includes("стоимость")) cols.cost = c;
    else if (k.includes("profit") || k.includes("прибыл")) cols.profit = c;
  }

  return cols;
}

function readMetrics(row: unknown[], cols: ColumnMap, hasProfit: boolean): RealizationMetrics {
  const get = (c: number) => (c >= 0 ? round2(toNum(row[c])) : 0);
  const qtySale = get(cols.qtySale);
  const qtyReturn = get(cols.qtyReturn);
  const qtyNet = cols.qtyNet >= 0 ? get(cols.qtyNet) : round2(qtySale + qtyReturn);
  const sumSale = get(cols.sumSale);
  const sumReturn = get(cols.sumReturn);
  const sumNet = cols.sumNet >= 0 ? get(cols.sumNet) : round2(sumSale + sumReturn);
  const m: RealizationMetrics = {
    qtySale,
    qtyReturn,
    qtyNet,
    sumSale,
    sumReturn,
    sumNet,
    excise: get(cols.excise),
    vat: get(cols.vat),
    sumNoTax: get(cols.sumNoTax)
  };
  if (hasProfit) {
    m.cost = get(cols.cost);
    m.profit = get(cols.profit);
  }
  return m;
}

function extractPeriodLabel(title: string): string | undefined {
  const match = title.match(MONTHS_NOM_RE);
  if (match) return match[0].trim();
  const afterZa = title.match(/\bза\s+(.+?)(?:\s*г\.?)?$/i);
  return afterZa ? afterZa[1].trim() : undefined;
}

function hasAnyValue(m: RealizationMetrics): boolean {
  return (
    Math.abs(m.qtySale) > 0 ||
    Math.abs(m.qtyReturn) > 0 ||
    Math.abs(m.qtyNet) > 0 ||
    Math.abs(m.sumSale) > 0 ||
    Math.abs(m.sumReturn) > 0 ||
    Math.abs(m.sumNet) > 0 ||
    Math.abs(m.sumNoTax) > 0 ||
    Math.abs(m.cost ?? 0) > 0 ||
    Math.abs(m.profit ?? 0) > 0
  );
}

/** Разбирает Excel-файл «Отчет о реализации товаров (услуг)» из 1С. */
export function parseRealizationExcel(buffer: Buffer | Uint8Array): RealizationReport {
  let wb: XLSX.WorkBook;
  try {
    // cellStyles: true нужен, чтобы @e965/xlsx заполнил ws["!rows"][i].level (уровни группировки 1С).
    wb = XLSX.read(buffer, { type: "buffer", cellStyles: true, cellFormula: false });
  } catch {
    throw new RealizationParseError("не удалось открыть книгу отчёта о реализации");
  }

  const sheetName = wb.SheetNames.find((_, idx) => {
    const h = wb.Workbook?.Sheets?.[idx]?.Hidden;
    return h !== 1 && h !== 2;
  });
  if (!sheetName) throw new RealizationParseError("в книге нет видимого листа");

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
  const rowMeta = ws["!rows"] ?? [];

  let organization: string | undefined;
  let periodLabel: string | undefined;
  let headerRowIdx = -1;
  let kind: RealizationKind | null = null;

  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const first = cleanText(rows[i]?.[0]);
    const k = labelKey(first);
    if (!first) continue;
    if (k.includes("отчет о реализации")) {
      periodLabel = extractPeriodLabel(first);
      if (i > 0 && !organization) {
        const prev = cleanText(rows[i - 1]?.[0]);
        if (prev && !labelKey(prev).includes("сортировк")) organization = prev;
      }
      continue;
    }
    if (k === "контрагент") {
      headerRowIdx = i;
      kind = "client-tmc";
      break;
    }
    if (k.includes("номенклатурн") && k.includes("групп")) {
      headerRowIdx = i;
      kind = "tmc-client";
      break;
    }
  }

  if (headerRowIdx < 0 || !kind) {
    throw new RealizationParseError("не найдена шапка отчёта о реализации (Контрагент / Номенклатурная группа)");
  }

  const cols = detectColumns(rows[headerRowIdx] ?? []);
  if (cols.sumNet < 0 && cols.sumSale < 0) {
    throw new RealizationParseError("в шапке отчёта о реализации нет колонки суммы реализации");
  }
  const hasProfit = cols.cost >= 0 || cols.profit >= 0;

  // Подзаголовки уровней 1 и 2 идут сразу под headerRowIdx (например R7, R8) и не имеют числовых значений.
  const levelHeaders: string[] = [cleanText(rows[headerRowIdx]?.[0])];
  let dataStartIdx = headerRowIdx + 1;
  while (dataStartIdx < rows.length && levelHeaders.length < 3) {
    const row = rows[dataStartIdx] ?? [];
    const first = cleanText(row[0]);
    const m = readMetrics(row, cols, hasProfit);
    if (first && !hasAnyValue(m)) {
      levelHeaders.push(first);
      dataStartIdx++;
    } else {
      break;
    }
  }

  const levels: [string, string, string] = kind === "client-tmc"
    ? ["Клиент", "Группа ТМЦ", "Номенклатура"]
    : ["Группа ТМЦ", "Номенклатура", "Клиент"];

  const nodes: RealizationNode[] = [];
  let currentL0: RealizationNode | null = null;
  let currentL1: RealizationNode | null = null;
  let fileTotals: RealizationMetrics | null = null;

  for (let i = dataStartIdx; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rawName = cleanText(row[0]);
    const nameKey = labelKey(rawName);
    const metrics = readMetrics(row, cols, hasProfit);
    if (!rawName && !hasAnyValue(metrics)) continue;

    const lvl = Number(rowMeta[i]?.level ?? 0);
    if (lvl === 0 && (nameKey === "итого" || nameKey === "всего")) {
      fileTotals = metrics;
      break;
    }

    const displayName = rawName || UNGROUPED_LABEL;
    if (lvl <= 0) {
      currentL0 = { name: displayName, metrics, children: [] };
      currentL1 = null;
      nodes.push(currentL0);
    } else if (lvl === 1) {
      if (!currentL0) {
        currentL0 = { name: UNGROUPED_LABEL, metrics: emptyMetrics(hasProfit), children: [] };
        nodes.push(currentL0);
      }
      currentL1 = { name: displayName, metrics, children: [] };
      currentL0.children!.push(currentL1);
    } else {
      if (!currentL0) {
        currentL0 = { name: UNGROUPED_LABEL, metrics: emptyMetrics(hasProfit), children: [] };
        nodes.push(currentL0);
      }
      if (!currentL1) {
        currentL1 = { name: UNGROUPED_LABEL, metrics: emptyMetrics(hasProfit), children: [] };
        currentL0.children!.push(currentL1);
      }
      currentL1.children!.push({ name: displayName, metrics });
    }
  }

  // Убираем пустые массивы children у листовых узлов
  const cleanNodes = nodes.map((n0) => ({
    ...n0,
    ...(n0.children?.length
      ? {
          children: n0.children.map((n1) => ({
            ...n1,
            ...(n1.children?.length ? { children: n1.children } : { children: undefined })
          }))
        }
      : { children: undefined })
  }));

  const computedTotals = cleanNodes.reduce((acc, n) => addMetrics(acc, n.metrics), emptyMetrics(hasProfit));
  const warnings: string[] = [];
  if (fileTotals) {
    if (Math.abs(fileTotals.sumNet - computedTotals.sumNet) > 10) {
      warnings.push("итог реализации в файле расходится с суммой строк");
    }
    if (hasProfit && Math.abs((fileTotals.profit ?? 0) - (computedTotals.profit ?? 0)) > 10) {
      warnings.push("итог прибыли в файле расходится с суммой строк");
    }
  }

  return {
    kind,
    ...(organization ? { organization } : {}),
    ...(periodLabel ? { periodLabel } : {}),
    hasProfit,
    levels,
    nodes: cleanNodes,
    totals: fileTotals ?? computedTotals,
    warnings
  };
}

interface LeafTuple {
  client: string;
  group: string;
  item: string;
  metrics: RealizationMetrics;
}

function collectLeaves(report: RealizationReport): LeafTuple[] {
  const out: LeafTuple[] = [];
  for (const n0 of report.nodes) {
    if (!n0.children?.length) {
      out.push(
        report.kind === "client-tmc"
          ? { client: n0.name, group: UNGROUPED_LABEL, item: UNGROUPED_LABEL, metrics: n0.metrics }
          : { group: n0.name, item: UNGROUPED_LABEL, client: UNGROUPED_LABEL, metrics: n0.metrics }
      );
      continue;
    }
    for (const n1 of n0.children) {
      if (!n1.children?.length) {
        out.push(
          report.kind === "client-tmc"
            ? { client: n0.name, group: n1.name, item: UNGROUPED_LABEL, metrics: n1.metrics }
            : { group: n0.name, item: n1.name, client: UNGROUPED_LABEL, metrics: n1.metrics }
        );
        continue;
      }
      for (const n2 of n1.children) {
        out.push(
          report.kind === "client-tmc"
            ? { client: n0.name, group: n1.name, item: n2.name, metrics: n2.metrics }
            : { group: n0.name, item: n1.name, client: n2.name, metrics: n2.metrics }
        );
      }
    }
  }
  return out;
}

/**
 * Автоматически строит противоположный разрез (ТМЦ-Клиент из Клиент-ТМЦ или наоборот)
 * по листовым строкам, если финансист загрузил только один из двух файлов.
 */
export function deriveOppositeRealization(source: RealizationReport): RealizationReport {
  const targetKind: RealizationKind = source.kind === "client-tmc" ? "tmc-client" : "client-tmc";
  const leaves = collectLeaves(source);

  const l0Map = new Map<string, Map<string, Map<string, RealizationMetrics>>>();
  for (const leaf of leaves) {
    const [k0, k1, k2] = targetKind === "client-tmc"
      ? [leaf.client, leaf.group, leaf.item]
      : [leaf.group, leaf.item, leaf.client];

    let l1Map = l0Map.get(k0);
    if (!l1Map) {
      l1Map = new Map();
      l0Map.set(k0, l1Map);
    }
    let l2Map = l1Map.get(k1);
    if (!l2Map) {
      l2Map = new Map();
      l1Map.set(k1, l2Map);
    }
    const prev = l2Map.get(k2);
    l2Map.set(k2, prev ? addMetrics(prev, leaf.metrics) : leaf.metrics);
  }

  const nodes: RealizationNode[] = [];
  for (const [k0, l1Map] of l0Map.entries()) {
    const l1Nodes: RealizationNode[] = [];
    let l0Metrics = emptyMetrics(source.hasProfit);
    for (const [k1, l2Map] of l1Map.entries()) {
      const l2Nodes: RealizationNode[] = [];
      let l1Metrics = emptyMetrics(source.hasProfit);
      for (const [k2, m] of l2Map.entries()) {
        l2Nodes.push({ name: k2, metrics: m });
        l1Metrics = addMetrics(l1Metrics, m);
      }
      l1Nodes.push({ name: k1, metrics: l1Metrics, children: l2Nodes });
      l0Metrics = addMetrics(l0Metrics, l1Metrics);
    }
    nodes.push({ name: k0, metrics: l0Metrics, children: l1Nodes });
  }

  return {
    kind: targetKind,
    ...(source.organization ? { organization: source.organization } : {}),
    ...(source.periodLabel ? { periodLabel: source.periodLabel } : {}),
    hasProfit: source.hasProfit,
    levels: targetKind === "client-tmc"
      ? ["Клиент", "Группа ТМЦ", "Номенклатура"]
      : ["Группа ТМЦ", "Номенклатура", "Клиент"],
    nodes,
    totals: source.totals,
    derived: true,
    warnings: []
  };
}
