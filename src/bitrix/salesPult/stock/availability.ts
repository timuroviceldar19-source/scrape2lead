// Склад 1С × Радар и Планы. Из материальных ведомостей финансового отчёта берутся только штуки
// (конечный остаток) по группе, виду и диагонали — без сумм, компаний, складов и номенклатуры:
// владелец разрешил менеджерам видеть доступный склад без цен.
//
// Менеджер видит на карточке лота или плана, есть ли товар («склад: 69 шт · 75″»), директор на «Финансах» —
// спрос на залежавшуюся позицию («спрос: 3 лота на 24 шт»). Сопоставление считается здесь, на сервере:
// страница получает готовые подсказки по ID сделок и только рисует их.

import { z } from "zod";
import { isStockStagnant } from "../finance/insights.js";
import type { FinanceView } from "../finance/types.js";
import type { PlansMonitorView } from "../plans/types.js";
import type { RadarView } from "../radar/types.js";
import { classifyStockName, DIAGONAL_KINDS, stockDiagonal, stockKey, type StockGroup } from "./classify.js";

const Diagonal = z.number().int().positive().nullable();
const Qty = z.number().finite().nonnegative();

/** Строка склада: штуки одного вида (и диагонали) по всем компаниям и складам. */
const StockRowSchema = z.object({
  key: z.string().min(1),
  group: z.enum(["ИП", "КТ"]),
  kind: z.string().min(1),
  diagonal: Diagonal,
  qty: Qty,
  /** Из них без расхода за период (`isStockStagnant`). */
  stagnantQty: Qty
}).strict();

/** Готовое сопоставление для карточек: одинаковый результат — один элемент со списком ID сделок. */
const StockHintSchema = z.object({
  qty: z.number().finite().positive(),
  /** Диагональ совпавших строк склада; приблизительное совпадение — null. */
  diagonal: Diagonal,
  /** Итог по виду: модель и диагональ со складом не сверены. */
  approx: z.boolean(),
  ids: z.array(z.string().min(1))
}).strict();

/** `.strict()`: лишнее поле (сумма, компания, склад) делает склад недействительным — он не уйдёт менеджеру. */
export const StockAvailabilitySchema = z.object({
  /** Дата данных финансового отчёта. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Отчёт старше `STOCK_STALE_DAYS` дней на дату сборки. */
  stale: z.boolean(),
  rows: z.array(StockRowSchema),
  hints: z.array(StockHintSchema).optional()
}).strict();

export type StockRow = z.infer<typeof StockRowSchema>;
export type StockHint = z.infer<typeof StockHintSchema>;
export type StockAvailability = z.infer<typeof StockAvailabilitySchema>;

export interface StockMatch {
  qty: number;
  diagonal: number | null;
  approx: boolean;
}

/** Спрос на строку склада: открытые лоты и планы, которым подходит эта строка. */
export interface StockDemandRow {
  key: string;
  lots: number;
  qty: number;
  /** Из них подошли без точной диагонали (только для панелей и мониторов). */
  approxLots: number;
}

export interface StockItemRef {
  group: StockGroup;
  kind: string;
  itemName: string;
}

export const STOCK_STALE_DAYS = 3;
const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 1000) / 1000;

function compareRows(a: StockRow, b: StockRow): number {
  return a.group.localeCompare(b.group, "ru") || a.kind.localeCompare(b.kind, "ru") ||
    (a.diagonal ?? -1) - (b.diagonal ?? -1);
}

/** Штуки на складе по (группа, вид, диагональ). Нет финансов, отчёта или ведомостей — null. */
export function buildStockAvailability(finance: FinanceView | undefined, asOfDate: string): StockAvailability | null {
  const report = finance?.report;
  const sheets = report?.stock ?? [];
  if (!report || !sheets.length) return null;
  const rows = new Map<string, StockRow>();
  for (const sheet of sheets) {
    for (const warehouse of sheet.warehouses) {
      for (const item of warehouse.items) {
        if (!(item.endQty > 0)) continue;
        const c = classifyStockName(item.name);
        if (!c) continue;
        const key = stockKey(c.group, c.kind, c.diagonal);
        const row = rows.get(key) ?? { key, group: c.group, kind: c.kind, diagonal: c.diagonal, qty: 0, stagnantQty: 0 };
        row.qty = round(row.qty + item.endQty);
        if (isStockStagnant(sheet.hasMoves, item)) row.stagnantQty = round(row.stagnantQty + item.endQty);
        rows.set(key, row);
      }
    }
  }
  const age = (Date.parse(asOfDate) - Date.parse(report.dataDate)) / DAY;
  return { asOf: report.dataDate, stale: Number.isFinite(age) && age > STOCK_STALE_DAYS, rows: [...rows.values()].sort(compareRows) };
}

interface RowsMatch {
  rows: StockRow[];
  diagonal: number | null;
  exact: boolean;
}

/**
 * Какие строки склада подходят товару. Диагональ в названии — строки этой диагонали, а если таких нет —
 * панели неизвестного размера (приблизительно). Диагонали нет — весь вид (приблизительно).
 */
function matchRows(availability: StockAvailability, item: StockItemRef): RowsMatch | null {
  const kindRows = availability.rows.filter((r) => r.group === item.group && r.kind === item.kind && r.qty > 0);
  if (!kindRows.length) return null;
  const diagonal = stockDiagonal(item.kind, item.itemName);
  if (diagonal === null) return { rows: kindRows, diagonal: null, exact: false };
  const exact = kindRows.filter((r) => r.diagonal === diagonal);
  if (exact.length) return { rows: exact, diagonal, exact: true };
  const unknown = kindRows.filter((r) => r.diagonal === null);
  return unknown.length ? { rows: unknown, diagonal: null, exact: false } : null;
}

/** Сколько штук подходит карточке: точно по диагонали из названия, иначе итог по виду с `approx`. */
export function matchStock(availability: StockAvailability | null | undefined, item: StockItemRef): StockMatch | null {
  if (!availability) return null;
  const m = matchRows(availability, item);
  const qty = m ? round(m.rows.reduce((s, r) => s + r.qty, 0)) : 0;
  return m && qty > 0 ? { qty, diagonal: m.diagonal, approx: !m.exact } : null;
}

interface OpenItem extends StockItemRef {
  id: string;
  qty: number;
  planNumber: string;
  source: "lot" | "plan";
  /** Входит в спрос: лоты «Подать сегодня» и «Успеть с замечанием», открытые планы. Второй шанс — нет. */
  demand: boolean;
}

interface StockSources {
  radar?: RadarView | null;
  plans?: PlansMonitorView | null;
}

function openItems({ radar, plans }: StockSources): OpenItem[] {
  const items: OpenItem[] = [];
  for (const group of [radar?.ip, radar?.kt]) {
    for (const column of ["submitToday", "discussion", "secondChance"] as const) {
      for (const c of group?.[column] ?? []) {
        items.push({ id: String(c.id), group: c.group, kind: c.kind, itemName: c.itemName, qty: c.qty || 0,
          planNumber: c.planNumber ?? "", source: "lot", demand: column !== "secondChance" });
      }
    }
  }
  for (const [view, group] of [[plans?.ip, "ИП"], [plans?.kt, "КТ"]] as const) {
    for (const d of view?.openPlans ?? []) {
      items.push({ id: String(d.id), group, kind: d.kind, itemName: d.itemName, qty: d.qty || 0,
        planNumber: d.planNumber ?? "", source: "plan", demand: true });
    }
  }
  return items;
}

/** Подсказки для всех карточек Радара и открытых планов; ID без склада в подсказки не попадают. */
export function withStockHints(
  availability: StockAvailability,
  radar: RadarView | null | undefined,
  plans: PlansMonitorView | null | undefined
): StockAvailability {
  const hints = new Map<string, StockHint>();
  const seen = new Set<string>();
  for (const item of openItems({ radar, plans })) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const m = matchStock(availability, item);
    if (!m) continue;
    const key = `${m.qty}|${m.diagonal}|${m.approx}`;
    const hint = hints.get(key) ?? { ...m, ids: [] };
    hint.ids.push(item.id);
    hints.set(key, hint);
  }
  return { ...availability, hints: [...hints.values()] };
}

/**
 * Спрос по строкам склада: открытые лоты Радара (подать сегодня и обсуждение) и открытые планы.
 * План, по которому уже есть лот (тот же номер плана), считается один раз. Строки без спроса не возвращаются.
 */
export function buildStockDemand(
  availability: StockAvailability | null | undefined,
  radar: RadarView | null | undefined,
  plans: PlansMonitorView | null | undefined
): StockDemandRow[] {
  if (!availability) return [];
  const demand = new Map<string, StockDemandRow>();
  const lotPlans = new Set<string>();
  const seen = new Set<string>();
  // Сначала лоты, затем планы: номера планов с лотами уже известны, когда доходим до планов.
  for (const item of openItems({ radar, plans })) {
    if (!item.demand || seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.source === "plan" && item.planNumber && lotPlans.has(item.planNumber)) continue;
    if (item.source === "lot" && item.planNumber) lotPlans.add(item.planNumber);
    const m = matchRows(availability, item);
    if (!m) continue;
    const approx = DIAGONAL_KINDS.has(item.kind) && !m.exact;
    for (const row of m.rows) {
      const d = demand.get(row.key) ?? { key: row.key, lots: 0, qty: 0, approxLots: 0 };
      d.lots += 1;
      d.qty = round(d.qty + item.qty);
      if (approx) d.approxLots += 1;
      demand.set(row.key, d);
    }
  }
  return availability.rows.flatMap((r) => demand.get(r.key) ?? []);
}

export type PayloadStockResult =
  | { ok: true; stock: StockAvailability | null | undefined }
  | { ok: false; issues: number };

/** Проверка `payload.stock`, прочитанного из JSON сборки: неверный формат не должен уйти на страницу. */
export function parsePayloadStock(value: unknown): PayloadStockResult {
  if (value === undefined || value === null) return { ok: true, stock: value };
  const parsed = StockAvailabilitySchema.safeParse(value);
  return parsed.success ? { ok: true, stock: parsed.data } : { ok: false, issues: parsed.error.issues.length };
}

/** Склад для варианта страницы: подсказки только для карточек и планов, которые в нём есть. */
export function stockForViewer(
  stock: StockAvailability | null | undefined,
  payload: StockSources
): StockAvailability | null | undefined {
  if (!stock) return stock;
  const ids = new Set(openItems(payload).map((item) => item.id));
  const hints = (stock.hints ?? []).map((h) => ({ ...h, ids: h.ids.filter((id) => ids.has(id)) })).filter((h) => h.ids.length);
  return { ...stock, hints };
}
