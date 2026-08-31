/**
 * Основной веб-портал госзакупок РК.
 *
 * В августе 2026 площадка переехала с goszakup.gov.kz на procurement.gov.kz: приложение
 * то же самое (те же пути и вёрстка), сменился только хост. Старый домен больше не
 * отвечает, а на новом не резолвится `www.` — поэтому origin здесь без поддомена.
 *
 * Поддомены `ows.goszakup.gov.kz` (API v3) и `v3bl.goszakup.gov.kz` (файлы, price module)
 * НЕ переезжали и продолжают работать — их константы живут отдельно и этого модуля не
 * касаются.
 */

const DEFAULT_ORIGIN = "https://procurement.gov.kz";

/** Хост, на который портал переехал. */
const CURRENT_HOST = "procurement.gov.kz";

/**
 * Исторический хост. Ссылки на него лежат в SQLite и в карточках сделок Bitrix, поэтому
 * при чтении он остаётся валидным — иначе развалится дедупликация по plan_point_id.
 */
const LEGACY_HOST = "goszakup.gov.kz";

/** Базовый URL портала без завершающего слэша. Переопределяется через GZ_PORTAL_BASE_URL. */
export const GZ_PORTAL_ORIGIN = normalizeOrigin(process.env.GZ_PORTAL_BASE_URL) ?? DEFAULT_ORIGIN;

/**
 * Принадлежит ли хост основному порталу — текущему домену или историческому.
 * Поддомены исторического домена (v3bl, ows) сохраняют прежнюю трактовку.
 */
export function isGzPortalHost(hostname: string | null | undefined): boolean {
  const host = hostname?.trim().toLocaleLowerCase("en");
  if (!host) return false;
  if (host === CURRENT_HOST || host === `www.${CURRENT_HOST}`) return true;
  return host === LEGACY_HOST || host.endsWith(`.${LEGACY_HOST}`);
}

/** То же, но без поддоменов исторического домена — для белых списков ссылок на профили. */
export function isGzPortalRootHost(hostname: string | null | undefined): boolean {
  const host = hostname?.trim().toLocaleLowerCase("en");
  if (!host) return false;
  return host === CURRENT_HOST
    || host === `www.${CURRENT_HOST}`
    || host === LEGACY_HOST
    || host === `www.${LEGACY_HOST}`;
}

function normalizeOrigin(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}
