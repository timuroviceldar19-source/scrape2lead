/**
 * Готовые сообщения для аутрича — перенос шаблонов из docs/whatsapp-messages.md
 * с подстановкой актуальных цифр по выгрузке.
 */

export interface ListStats {
  /** Сколько компаний в списке. */
  companyCount: number;
  /** Суммарный бюджет активных контрактов по списку, ₸. */
  totalActiveBudget: number;
  /** У скольких компаний есть прямой телефон. */
  withPhoneCount: number;
  /** Самый крупный контракт/портфель в списке, ₸. */
  topContractBudget: number;
}

/** Шаблон 1: первое касание (сегмент 1 — поставщики строительных компаний). */
export function buildFirstTouchMessage(stats: ListStats): string {
  return [
    "Добрый день! Вы поставляете материалы/услуги строительным компаниям?",
    "",
    `У меня список ${stats.companyCount} строительных компаний Астаны и Алматы, которые прямо сейчас исполняют госконтракты — суммарно более ${formatTengeShort(stats.totalActiveBudget)}. У них есть бюджеты и текущие объекты.`,
    "",
    `В списке: прямые телефоны (${stats.withPhoneCount} из ${stats.companyCount}), директора, суммы и количество контрактов.`,
    "",
    "Прикладываю 3 компании из списка бесплатно — оцените качество данных. Полная версия — 50 000 ₸ разово."
  ].join("\n");
}

/** Шаблон 2: фоллоу-ап через день. */
export function buildFollowUpMessage(stats: ListStats): string {
  return [
    "Добрый день ещё раз! Посмотрели пример?",
    "",
    `Первая компания в списке исполняет контракты на ${formatTengeShort(stats.topContractBudget)} — если выйдете хотя бы на одного такого клиента, список окупится в сотни раз.`,
    "",
    "Если неактуально — просто напишите «нет», больше не побеспокою."
  ].join("\n");
}

export interface FactoringStats {
  /** Сколько свежих победителей в недельном дайджесте. */
  winnerCount: number;
}

/** Шаблон 7: сегмент 2 — факторинг/банки. */
export function buildFactoringMessage(stats: FactoringStats): string {
  return [
    "Тема: Лиды для факторинга — свежие победители госзакупок",
    "",
    "Добрый день!",
    "",
    `Делаю аналитику по госзакупкам РК. Готов еженедельно поставлять список компаний, которые только что выиграли тендеры: БИН, сумма контракта, заказчик, телефон директора. На этой неделе таких компаний ${stats.winnerCount}.`,
    "",
    "Победитель тендера — горячий лид для факторинга и банковских гарантий: деньги по контракту придут через месяцы, оборотные средства нужны сейчас.",
    "",
    "Готов прислать прошлую неделю бесплатно как пилот. Интересно?"
  ].join("\n");
}

/** 44_200_000_000 → "44,2 млрд ₸"; 150_000_000 → "150 млн ₸"; 900_000 → "900 тыс ₸". */
export function formatTengeShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) return `${formatShortNumber(amount / 1_000_000_000)} млрд ₸`;
  if (abs >= 1_000_000) return `${formatShortNumber(amount / 1_000_000)} млн ₸`;
  if (abs >= 1_000) return `${formatShortNumber(amount / 1_000)} тыс ₸`;
  return `${Math.round(amount)} ₸`;
}

function formatShortNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)).replace(".", ",");
}

/**
 * wa.me-ссылка с предзаполненным текстом. Берёт первый телефон из строки
 * ("+7 (777) 123-45-67; +7 ..."), нормализует к формату 7XXXXXXXXXX.
 */
export function buildWaLink(phoneRaw: string | null | undefined, text: string): string | null {
  const phone = normalizeKzPhone(phoneRaw);
  if (!phone) return null;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function normalizeKzPhone(phoneRaw: string | null | undefined): string | null {
  if (!phoneRaw) return null;
  const first = phoneRaw.split(/[;,]/)[0] ?? "";
  const digits = first.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return digits;
  if (digits.length === 10) return `7${digits}`;
  return null;
}
