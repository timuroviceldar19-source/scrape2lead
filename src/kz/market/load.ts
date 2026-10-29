import fs from "node:fs";
import path from "node:path";
import type { MarketConfig, MarketView } from "./types.js";
import { loadMarketConfig } from "./config.js";
import { DEFAULT_MARKET_UNITS_PATH, loadStoredMarketUnits } from "./fetchMarket.js";
import { buildMarketView } from "./aggregate.js";

export interface LoadMarketOptions {
  unitsFilePath?: string;
  todayAlmaty: string;
  cfg?: MarketConfig;
}

export function loadMarketView(options: LoadMarketOptions): MarketView {
  const {
    unitsFilePath = DEFAULT_MARKET_UNITS_PATH,
    todayAlmaty,
    cfg = loadMarketConfig()
  } = options;

  const resolved = path.resolve(unitsFilePath);
  let updatedAt: string | undefined;
  if (fs.existsSync(resolved)) {
    try {
      const stat = fs.statSync(resolved);
      updatedAt = stat.mtime.toISOString().slice(0, 10);
    } catch {}
  }

  const storedUnits = loadStoredMarketUnits(unitsFilePath);
  if (storedUnits.length === 0) {
    console.log(`[Рынок] Кэш ${unitsFilePath} не найден или пуст`);
    return {
      asOf: todayAlmaty,
      ip: null,
      kt: null,
      "ИП": null,
      "КТ": null,
      months: [],
      error: "Данные рынка ещё собираются."
    };
  }

  const maxDate = storedUnits.reduce((m, u) => (u.date > m ? u.date : m), "");
  if (!updatedAt && maxDate) {
    updatedAt = maxDate;
  }

  const view = buildMarketView(storedUnits, todayAlmaty, cfg, undefined, updatedAt);
  if (view.ip && view.kt) {
    console.log(
      `[Рынок] позиций: ${storedUnits.length}, ИП договоров: ${view.ip.total.contracts}, КТ договоров: ${view.kt.total.contracts}`
    );
  }
  return view;
}
