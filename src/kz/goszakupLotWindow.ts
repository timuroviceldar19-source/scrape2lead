import { goszakupGraphqlPage, type GoszakupGraphqlOptions } from "./goszakupGraphql.js";

/** Приём заявок по лоту из реестра: местное время Алматы, `YYYY-MM-DD HH:mm:ss`. */
export interface LotBidWindow {
  startDate: string | null;
  endDate: string | null;
}

const LOT_WINDOW = `query($lot: String) {
  Lots(filter: { lotNumber: $lot }, limit: 1) { lotNumber TrdBuy { startDate endDate } }
}`;

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Срок приёма заявок лота по его номеру. `null`, если лота нет в реестре или у него нет ни одной даты.
 * Номер лота ищем самим номером: число до дефиса — старый пункт плана, а не ключ.
 */
export async function fetchLotBidWindow(lotNumber: string, options: GoszakupGraphqlOptions): Promise<LotBidWindow | null> {
  const page = await goszakupGraphqlPage<{ TrdBuy?: { startDate?: unknown; endDate?: unknown } | null }>(
    LOT_WINDOW,
    { lot: lotNumber },
    "Lots",
    options
  );
  const buy = page.items[0]?.TrdBuy;
  const window = { startDate: clean(buy?.startDate), endDate: clean(buy?.endDate) };
  return window.startDate || window.endDate ? window : null;
}

export interface LotBidWindows {
  /** Только лоты, у которых реестр назвал хотя бы одну дату. */
  windows: Map<string, LotBidWindow>;
  /** Лоты, которые не удалось прочитать (сбой сети или реестра). */
  failed: string[];
}

/** Много лотов, не больше нескольких запросов сразу. Сбой одного лота не останавливает остальные. */
export async function fetchLotBidWindows(
  lotNumbers: string[],
  options: GoszakupGraphqlOptions,
  concurrency = 6
): Promise<LotBidWindows> {
  const windows = new Map<string, LotBidWindow>();
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < lotNumbers.length) {
      const lotNumber = lotNumbers[next++];
      try {
        const window = await fetchLotBidWindow(lotNumber, options);
        if (window) windows.set(lotNumber, window);
      } catch {
        failed.push(lotNumber);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, lotNumbers.length) }, worker));
  return { windows, failed };
}
