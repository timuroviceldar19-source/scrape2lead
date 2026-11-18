/**
 * Связь нового пункта zakup.gov.kz с уже заведённой сделкой.
 *
 * Заказчик, изменивший пункт плана, получает новый номер пункта. Портал отдавал и номер исходного
 * пункта («№ пункта плана»), и робот находил по нему старую сделку. zakup.gov.kz исходный номер в
 * карточке не показывает, но поиск `q=<номер>` возвращает и сам пункт, и его более поздние версии.
 * Поэтому для каждой сделки того же заказчика с тем же кодом ЕНС ТРУ спрашиваем zakup по её номерам
 * и считаем пункт версией сделки, если zakup сам его там показал.
 *
 * Если zakup не знает ни одного номера сделки (старые пункты он не хранит), проверить связь нельзя.
 * Тогда версией считаем сделку с той же плановой суммой: тот же заказчик, тот же код и та же сумма до
 * тенге — это та же закупка (18.11.2026: 9 ноутбуков на 4 230 000 ₸ стали бы второй сделкой к 42927).
 */
export interface GzRevisionCandidateDeal {
  ID?: string | number;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_6A436D5A3614C?: string | number | null;
  OPPORTUNITY?: string | number | null;
  UF_CRM_1715597423325?: string | number | null;
}

export interface GzZakupRevisionLink<T extends GzRevisionCandidateDeal> {
  duplicate: { deal: T; reason: "plan revision" | "plan revision (same amount)"; blocking: true } | null;
  /** Сделки, ни один номер которых zakup не знает: проверить связь нельзя. */
  unverified: string[];
}

/** Номера пунктов, которые zakup показывает по запросу `q=<номер>`. */
export type ZakupPlanChainLookup = (planNumber: string) => Promise<readonly string[]>;

export const GZ_PLAN_NUMBER_FIELD = "UF_CRM_PLAN_ID";
export const GZ_PLAN_POINT_FIELD = "UF_CRM_6A436D5A3614C";

export function isZakupPlanUrl(value: string | null | undefined): boolean {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" && url.hostname === "zakup.gov.kz" && url.pathname.startsWith("/plan-items/");
  } catch {
    return false;
  }
}

export interface ZakupRevisionLinkOptions {
  /** Плановая сумма строки: по ней узнаём версию, когда zakup не знает номеров сделки. */
  amount?: number;
}

// Суммы в плане с тиынами, расхождение меньше тенге — округление.
const AMOUNT_TOLERANCE = 1;

export async function findZakupRevisionDeal<T extends GzRevisionCandidateDeal>(
  planPointId: string,
  candidates: readonly T[],
  chain: ZakupPlanChainLookup,
  options: ZakupRevisionLinkOptions = {}
): Promise<GzZakupRevisionLink<T>> {
  const point = planPointId.trim();
  const unverified: string[] = [];
  const unverifiedDeals: T[] = [];
  const seenDeals = new Set<string>();
  for (const deal of candidates) {
    const dealId = String(deal.ID ?? "").trim();
    if (!dealId || seenDeals.has(dealId)) continue;
    seenDeals.add(dealId);
    const numbers = [...new Set([deal.UF_CRM_PLAN_ID, deal.UF_CRM_6A436D5A3614C]
      .map((value) => String(value ?? "").trim())
      .filter((value) => /^\d+$/.test(value)))];
    // Сделка этого же пункта — не другая версия; её находит обычный поиск по ORIGIN_ID.
    if (!numbers.length || numbers.includes(point)) continue;
    let known = false;
    for (const number of numbers) {
      const found = (await chain(number)).map((value) => String(value).trim());
      if (found.length) known = true;
      if (found.includes(point)) return { duplicate: { deal, reason: "plan revision", blocking: true }, unverified };
    }
    if (!known) {
      unverified.push(dealId);
      unverifiedDeals.push(deal);
    }
  }
  const amount = options.amount;
  if (amount !== undefined && amount > 0) {
    const sameAmount = unverifiedDeals.find((deal) => {
      const planned = toAmount(deal.UF_CRM_1715597423325) ?? toAmount(deal.OPPORTUNITY);
      return planned !== null && Math.abs(planned - amount) < AMOUNT_TOLERANCE;
    });
    if (sameAmount) return { duplicate: { deal: sameAmount, reason: "plan revision (same amount)", blocking: true }, unverified: [] };
  }
  return { duplicate: null, unverified };
}

function toAmount(value: string | number | null | undefined): number | null {
  const text = String(value ?? "").replace(/[\s\u00a0]+/g, "").replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
