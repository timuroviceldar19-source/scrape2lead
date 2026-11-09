import { DEFAULT_MARKET_UNITS_PATH, fetchMarketUnits, loadStoredMarketUnits, saveStoredMarketUnits, mergeMarketUnits, logMarketRefreshCounts } from "./fetchMarket.js";

export interface UpdateMarketWindowOptions {
  todayAlmaty: string;
  token?: string | null;
  strict?: boolean;
  filePath?: string;
  fetchUnits?: typeof fetchMarketUnits;
}

/** Сохраняет окно только после полной выгрузки; строгий режим останавливает восстановление. */
export async function updateMarketWindow(options: UpdateMarketWindowOptions): Promise<number | undefined> {
  const { todayAlmaty, filePath = DEFAULT_MARKET_UNITS_PATH, fetchUnits = fetchMarketUnits } = options;
  const gzToken = options.token ?? null;
  const d = new Date(Date.parse(`${todayAlmaty}T12:00:00Z`));
  d.setDate(d.getDate() - 45);
  const cutoffDate = d.toISOString().slice(0, 10);
  try {
    console.log(`[Рынок] Утреннее обновление за последние 45 дней (с ${cutoffDate})...`);
    const result = await fetchUnits({
      token: gzToken,
      fromDate: cutoffDate,
      toDate: todayAlmaty
    });
    const { units: freshUnits, source, keepContractIds } = result;
    const existingUnits = loadStoredMarketUnits(filePath);
    const merged = mergeMarketUnits(existingUnits, freshUnits, cutoffDate, todayAlmaty, keepContractIds);
    saveStoredMarketUnits(merged, filePath);
    logMarketRefreshCounts(existingUnits, result, cutoffDate, todayAlmaty);
    console.log(`[Рынок] Утреннее обновление (${source}): свежих ${freshUnits.length}, всего ${merged.length}`);
    return merged.length;
  } catch (marketErr: any) {
    if (options.strict) throw marketErr;
    console.warn(`::warning::[Рынок] Ошибка при утреннем обновлении рынка: ${marketErr?.message || marketErr}`);
  }
}
