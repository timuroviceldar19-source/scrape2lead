import type { LaunchOptions } from "playwright";

/**
 * Сертификат procurement.gov.kz истёк 18.11.2026 в 23:59:59 GMT, и портал его не продлил, хотя сам
 * продолжает публиковать объявления. Браузер робота отказывался открывать страницы
 * (`net::ERR_CERT_DATE_INVALID`), и с 19.11 лоты и контакты новых заказчиков не приходили.
 *
 * Доверяем ровно этому ключу, а не «любому сертификату портала»: Chromium пропускает ошибку сертификата,
 * только если в цепочке есть сертификат с указанным открытым ключом (SHA-256 от SubjectPublicKeyInfo,
 * base64). Любой другой просроченный, самоподписанный или поддельный сертификат по-прежнему отклоняется.
 * Подделать такой сертификат может только владелец закрытого ключа портала. Когда портал продлит
 * сертификат, проверка снова проходит обычным путём и исключение просто перестаёт срабатывать.
 *
 * Ключ сертификата procurement.gov.kz (RapidSSL TLS RSA CA G1, действовал 04.05–18.11.2026, лист SHA-256
 * 5B:ED:DC:A0:21:33:FB:A9:FD:DA:EF:C7:0C:9E:4B:33:38:B0:0E:A1:2D:00:6A:B3:57:EE:82:97:1A:1D:4C:AD).
 * Получить заново:
 * `openssl s_client -connect procurement.gov.kz:443 -servername procurement.gov.kz </dev/null | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl enc -base64`
 */
export const GZ_PORTAL_PINNED_SPKI: readonly string[] = ["9RlsLxKR74pobuctfC2lt7f8FaL4ri1iZg4DflJ9mjI="];

const SPKI_HASH = /^[A-Za-z0-9+/]{43}=$/;

/** Аргумент Chromium, который принимает сертификаты только с закреплёнными ключами. */
export function gzPortalChromiumArgs(pins: readonly string[] = GZ_PORTAL_PINNED_SPKI): string[] {
  const valid = pins.map((pin) => pin.trim()).filter((pin) => SPKI_HASH.test(pin));
  if (valid.length !== pins.length) throw new Error("GZ portal SPKI pin must be a base64 SHA-256 hash");
  return valid.length ? [`--ignore-certificate-errors-spki-list=${valid.join(",")}`] : [];
}

/** Параметры запуска браузера для страниц портала: свои аргументы сохраняются, ключ портала добавляется. */
export function gzPortalLaunchOptions(options: LaunchOptions = {}): LaunchOptions {
  return { ...options, args: [...(options.args ?? []), ...gzPortalChromiumArgs()] };
}
