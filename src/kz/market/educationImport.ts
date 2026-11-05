import type { MarketConfig, MarketUnit } from "./types.js";
import { marketConfigKey } from "./config.js";
import type { StoredMarketData } from "./fetchMarket.js";

export const EDUCATION_CODE = "329959.900.000019";
export interface EducationSupplement {
  fromDate: string;
  toDate: string;
  code: string;
  units: MarketUnit[];
}

/** Extend verified history without replacing old months with an incomplete new-platform import. */
export function importEducationHistory(stored: StoredMarketData, extra: EducationSupplement, cfg: MarketConfig): StoredMarketData {
  if (extra.code !== EDUCATION_CODE || !Array.isArray(extra.units) || !extra.units.length || !/^\d{4}-\d{2}-\d{2}$/.test(extra.fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(extra.toDate) || extra.fromDate > extra.toDate) {
    throw new Error("Invalid education history supplement");
  }
  if (!stored.units?.length) throw new Error("Verified market history is missing");
  const bins = new Set(cfg.ourBins.map(b => typeof b === "string" ? b : b.bin));
  const byKey = new Map<string, MarketUnit>();
  for (const u of extra.units) {
    if (u.code !== EDUCATION_CODE || u.group !== "ИП" || u.kind !== "Учебные комплекты" || !Number.isSafeInteger(u.id) || u.id <= 0 ||
        !Number.isSafeInteger(u.unitIndex) || u.unitIndex! < 0 || !Number.isFinite(u.sum) || u.sum < 0 ||
        !Number.isFinite(u.qty) || u.qty < 0 || !Number.isFinite(u.price) || u.price < 0 ||
        u.date < extra.fromDate || u.date > extra.toDate || u.month !== u.date.slice(0, 7) ||
        !/^\d{12}$/.test(u.supplier) || !/^\d{12}$/.test(u.customer)) {
      throw new Error("Invalid education contract item");
    }
    const key = `${u.id}|${u.unitIndex}`;
    if (byKey.has(key)) throw new Error("Duplicate education contract item");
    byKey.set(key, { ...u, us: bins.has(u.supplier) });
  }
  const retained = stored.units.filter(u => u.code !== EDUCATION_CODE || u.date < extra.fromDate || u.date > extra.toDate);
  return { ...stored, configKey: marketConfigKey(cfg), units: [...retained, ...byKey.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
