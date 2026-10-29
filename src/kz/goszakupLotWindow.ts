import { goszakupGraphqlAll } from "./goszakupGraphql.js";
import { zakupGet, zakupListAll } from "./zakupPublicApi.js";
import { withGzSourceFallback, type GzRegistryOptions } from "./zakupGzRegistry.js";

/** Приём заявок по лоту из реестра: местное время Алматы, `YYYY-MM-DD HH:mm:ss`. */
export interface LotBidWindow {
  startDate: string | null;
  endDate: string | null;
}

const LOT_WINDOW = `query($lot: String, $after: Int) {
  Lots(filter: { lotNumber: $lot }, limit: 200, after: $after) { lotNumber TrdBuy { id startDate endDate } }
}`;

export interface LotWindowOptions extends GzRegistryOptions {
  announcementId?: number | null;
  announcementIds?: ReadonlyMap<string, number>;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueWindow(windows: LotBidWindow[], lotNumber: string): LotBidWindow | null {
  const populated = windows.filter(window => window.startDate || window.endDate);
  if (new Set(populated.map(window => JSON.stringify(window))).size > 1) throw new Error(`у лота ${lotNumber} несколько объявлений с разными сроками`);
  return populated[0] ?? null;
}

/**
 * Срок приёма заявок лота по его номеру. `null`, если лота нет в реестре или у него нет ни одной даты.
 * Номер лота ищем самим номером: число до дефиса — старый пункт плана, а не ключ.
 */
export async function fetchLotBidWindow(lotNumber: string, options: LotWindowOptions = {}): Promise<LotBidWindow | null> {
  return withGzSourceFallback(async () => {
    const rows = await zakupListAll<{ lot_number?: string; announcement_external_id?: number; offer_start_date?: string | null; offer_end_date?: string | null }>(
      "/public/lots/", { lot_number: lotNumber, system_id: 1 }, options);
    const exact = rows.filter(row => row.lot_number === lotNumber && (!options.announcementId || Number(row.announcement_external_id) === options.announcementId));
    const direct = uniqueWindow(exact.map(lot => ({ startDate: zakupDateToAlmaty(lot.offer_start_date), endDate: zakupDateToAlmaty(lot.offer_end_date) })), lotNumber);
    if (direct || !options.announcementId) return direct;
    // Поисковый индекс содержит не все лоты; карточка объявления может содержать их полный список.
    const announcements = await zakupListAll<{ id: number; external_id?: number; system_id?: number; offer_start_date?: string | null; offer_end_date?: string | null }>(
      "/public/announcements/", { announcement_number: options.announcementId, system_id: 1 }, options);
    const recovered: LotBidWindow[] = [];
    for (const announcement of announcements) {
      if (Number(announcement.external_id) !== options.announcementId || (announcement.system_id != null && announcement.system_id !== 1)) continue;
      const body = await zakupGet<Array<{ lot_number?: string; system?: { id?: number }; is_externally_deleted?: boolean | number }> | { results: Array<{ lot_number?: string; system?: { id?: number }; is_externally_deleted?: boolean | number }>; next?: string | null }>(
        `/public/announcements/${announcement.id}/lots/`, {}, options);
      if (!Array.isArray(body) && (!Array.isArray(body?.results) || body.next)) throw new Error("zakup: неполный список лотов объявления");
      const lots = Array.isArray(body) ? body : body.results;
      if (!lots.some(lot => lot.lot_number === lotNumber && (lot.system?.id == null || lot.system.id === 1) && !lot.is_externally_deleted)) continue;
      recovered.push({ startDate: zakupDateToAlmaty(announcement.offer_start_date), endDate: zakupDateToAlmaty(announcement.offer_end_date) });
    }
    return uniqueWindow(recovered, lotNumber);
  }, async () => {
    const lots = await goszakupGraphqlAll<{ TrdBuy?: { id?: number; startDate?: unknown; endDate?: unknown } | null }>(
      LOT_WINDOW,
      { lot: lotNumber },
      "Lots",
      { ...options, token: options.token! }
    );
    const matching = lots.filter(lot => !options.announcementId || Number(lot.TrdBuy?.id) === options.announcementId);
    return uniqueWindow(matching.map(lot => ({ startDate: clean(lot.TrdBuy?.startDate), endDate: clean(lot.TrdBuy?.endDate) })), lotNumber);
  }, options.token);
}

/** Даты платформы содержат смещение; локальный часовой пояс процесса здесь не участвует. */
export function zakupDateToAlmaty(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("zakup: неверная дата срока приёма заявок");
  return new Date(Date.parse(value) + 5 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
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
  options: LotWindowOptions = {},
  concurrency = 4
): Promise<LotBidWindows> {
  const windows = new Map<string, LotBidWindow>();
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < lotNumbers.length) {
      const lotNumber = lotNumbers[next++];
      try {
        const window = await fetchLotBidWindow(lotNumber, { ...options, announcementId: options.announcementIds?.get(lotNumber) ?? options.announcementId });
        if (window) windows.set(lotNumber, window);
      } catch {
        failed.push(lotNumber);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, lotNumbers.length) }, worker));
  return { windows, failed };
}
