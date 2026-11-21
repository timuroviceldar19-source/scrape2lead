// Источники вердикта: срезы «Планов», «Рынка» и «Конкурентов» из payload, проверенные zod.
// Берутся только поля, которые читает вердикт. Битая запись (не объект, не тот тип) пропускается и считается,
// отсутствующий раздел — норма (пустой список). Тексты причин отклонений нужны только для категории и наружу не идут.

import { z } from "zod";
import type { SalesPultPayload } from "../types.js";

export type GroupKey = "ip" | "kt";

function makeSchemas(counter: { dropped: number }) {
  const str = z.string().catch("");
  const id = z.union([z.string(), z.number()]).transform(String).catch("");
  const num = z.number().finite().catch(0);
  const nullableNum = z.number().finite().nullable().catch(null);
  /** «Наша» отметка бывает числом (сумма, счётчик) и флагом. */
  const flag = z.unknown().transform((v) => v === true || (typeof v === "number" && v > 0));

  // Нет раздела (undefined/null) — норма; раздел не того типа — битая запись.
  const list = <T extends z.ZodTypeAny>(item: T) => z.unknown().transform((xs): Array<z.output<T>> => {
    if (xs == null) return [];
    if (!Array.isArray(xs)) { counter.dropped++; return []; }
    return xs.flatMap((x) => {
      const r = item.safeParse(x);
      if (r.success) return [r.data as z.output<T>];
      counter.dropped++;
      return [];
    });
  });
  const record = <T extends z.ZodTypeAny>(item: T) => z.unknown().transform((rec): Record<string, z.output<T>> => {
    const out: Record<string, z.output<T>> = {};
    if (rec == null) return out;
    if (typeof rec !== "object" || Array.isArray(rec)) { counter.dropped++; return out; }
    for (const [key, value] of Object.entries(rec)) {
      const r = item.safeParse(value);
      if (r.success) out[key] = r.data as z.output<T>;
      else counter.dropped++;
    }
    return out;
  });

  // ---------- «Планы» ----------
  const planSlice = z.object({
    customers: list(z.object({
      bin: str, name: str, wonCount: num,
      planList: list(z.object({ outcomeCategory: str }))
    })),
    lostTo: z.object({
      competitors: list(z.object({
        bin: str, name: str,
        deals: list(z.object({ id, customerBin: str, customerName: str, contractSum: nullableNum, planSum: num }))
      }))
    }).nullable().catch(null)
  });
  const planGroup = planSlice.extend({
    wonCustomers: list(z.object({ bin: str, name: str })),
    monthViews: record(planSlice)
  });

  // ---------- «Рынок» ----------
  const contract = z.object({ customerBin: str, customer: str, us: flag });
  const marketSlice = z.object({
    kinds: list(z.object({ kind: str, med: nullableNum, usMed: nullableNum, n: nullableNum })),
    customers: list(z.object({ bin: str, name: str, us: flag, contractList: list(contract) })),
    suppliers: list(z.object({ us: flag, contractList: list(contract) }))
  });
  const marketGroup = marketSlice.extend({ monthViews: record(marketSlice) });

  // ---------- «Конкуренты» ----------
  const lotRef = { annoId: id, lotNumber: id, customerBin: str, customerName: str };
  const priceTuple = z.object({ med: nullableNum, n: nullableNum }).catch({ med: null, n: null });
  const priceRow = z.object({ label: str, kind: str, compWinner: priceTuple, ourWinner: priceTuple });
  const compSlice = z.object({
    competitors: list(z.object({
      bin: str, name: str, us: flag,
      lotList: list(z.object({ ...lotRef, isWinner: flag, discountPct: nullableNum, bidTotalPrice: nullableNum, plannedSum: nullableNum }))
    })),
    headToHead: list(z.object({
      bin: str, name: str,
      lots: list(z.object({ ...lotRef, weWon: flag, rivalWon: flag, winnerDiscountPct: nullableNum, winnerBin: str, winnerName: str }))
    })),
    ourRejections: list(z.object({
      annoId: id, lotNumber: id, ourBin: str, customerName: str, rejectionShort: str, rejectionDetail: str
    })),
    specTemplates: list(z.object({
      templateName: str,
      winners: list(z.object({ name: str, sharePct: num, ourCompany: str })),
      lots: list(z.object({ ...lotRef, strength: z.enum(["strong", "partial"]).catch("partial"), sharePct: num }))
    })),
    prices: z.object({ rows: list(priceRow), kitsRow: priceRow.nullable().catch(null) }).catch({ rows: [], kitsRow: null })
  });
  const compGroup = compSlice.extend({ monthViews: record(compSlice) });

  return { planGroup, marketGroup, compGroup };
}

type Schemas = ReturnType<typeof makeSchemas>;
export type PlanSource = z.output<Schemas["planGroup"]>;
export type PlanSliceSource = Omit<PlanSource, "wonCustomers" | "monthViews">;
export type MarketSource = z.output<Schemas["marketGroup"]>;
export type MarketSliceSource = Omit<MarketSource, "monthViews">;
export type CompetitorsSource = z.output<Schemas["compGroup"]>;
export type CompetitorsSliceSource = Omit<CompetitorsSource, "monthViews">;

export interface BidSources {
  plans: Partial<Record<GroupKey, PlanSource>>;
  market: Partial<Record<GroupKey, MarketSource>>;
  competitors: Partial<Record<GroupKey, CompetitorsSource>>;
}

const GROUPS: GroupKey[] = ["ip", "kt"];

function group(view: unknown, key: GroupKey): unknown {
  if (!view || typeof view !== "object") return null;
  const v = view as Record<string, unknown>;
  return v.error ? null : v[key] ?? null;
}

/** Разбирает срезы payload; `dropped` — сколько битых записей пропущено (в лог идёт только число). */
export function parseBidSources(payload: Pick<SalesPultPayload, "plans" | "market" | "competitors">): { sources: BidSources; dropped: number } {
  const counter = { dropped: 0 };
  const s = makeSchemas(counter);
  const sources: BidSources = { plans: {}, market: {}, competitors: {} };
  for (const key of GROUPS) {
    const pairs = [
      ["plans", s.planGroup, group(payload.plans, key)],
      ["market", s.marketGroup, group(payload.market, key)],
      ["competitors", s.compGroup, group(payload.competitors, key)]
    ] as const;
    for (const [name, schema, raw] of pairs) {
      if (raw === null) continue;
      const r = schema.safeParse(raw);
      if (r.success) (sources[name] as Record<GroupKey, unknown>)[key] = r.data;
      else counter.dropped++;
    }
  }
  return { sources, dropped: counter.dropped };
}
