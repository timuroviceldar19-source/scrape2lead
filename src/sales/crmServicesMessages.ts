/**
 * Шаблоны первого касания для продажи CRM-услуг (Bitrix24/amoCRM).
 * Цифры кейса подставляются из CrmCaseStats; каноничные значения — из живого
 * проекта июля 2026 (см. docs/sales/case-gz-bitrix24.md).
 */

import { formatTengeShort } from "../kz/outreachMessages.js";

export { buildWaLink, normalizeKzPhone } from "../kz/outreachMessages.js";

export interface CrmCaseStats {
  /** Сколько сделок просканировано в кейсе. */
  dealsScanned: number;
  /** Сколько пар настоящих дублей найдено и убрано в карантин. */
  duplicatePairsFound: number;
  /** Сколько старых сделок получили ключ идемпотентности. */
  dealsKeyed: number;
  /** Цена «от» за разовый импорт, ₸. */
  importPriceFrom: number;
  /** Цена «от» за чистку CRM, ₸. */
  cleanupPriceFrom: number;
}

export const CRM_CASE_STATS: CrmCaseStats = {
  dealsScanned: 4075,
  duplicatePairsFound: 40,
  dealsKeyed: 130,
  importPriceFrom: 80_000,
  cleanupPriceFrom: 100_000
};

/** Первое касание: владельцу бизнеса / РОПу с Bitrix24. */
export function buildCrmFirstTouchMessage(stats: CrmCaseStats = CRM_CASE_STATS): string {
  return [
    "Добрый день! Вы работаете в Битрикс24?",
    "",
    `Я навожу порядок в CRM: импорт лидов без дублей, чистка базы, автозаливка заявок. Свежий кейс — база ${formatCount(stats.dealsScanned)} сделок: нашёл и убрал в карантин ${formatCount(stats.duplicatePairsFound)} пар дублей, повторный импорт теперь не создаёт ни одной копии.`,
    "",
    `Могу бесплатно за день сделать аудит вашей базы: сколько дублей, что можно автоматизировать. Если по итогам захотите чистку — от ${formatTengeShort(stats.cleanupPriceFrom)}, импорт под ключ — от ${formatTengeShort(stats.importPriceFrom)}.`,
    "",
    "Прислать пример отчёта?"
  ].join("\n");
}

/** Фоллоу-ап через 2–3 дня без ответа. */
export function buildCrmFollowUpMessage(stats: CrmCaseStats = CRM_CASE_STATS): string {
  return [
    "Добрый день ещё раз!",
    "",
    `Коротко, чем могу быть полезен: если менеджеры звонят одним и тем же клиентам дважды или база «распухла» от импортов — это лечится за 1–3 дня. В последнем проекте из ${formatCount(stats.dealsScanned)} сделок ${formatCount(stats.duplicatePairsFound)} пар оказались дублями.`,
    "",
    "Аудит бесплатный и ни к чему не обязывает. Если неактуально — напишите «нет», больше не побеспокою."
  ].join("\n");
}

/** Короткая версия питча для интеграторов Bitrix24 (WhatsApp/Telegram). */
export function buildIntegratorMessage(stats: CrmCaseStats = CRM_CASE_STATS): string {
  return [
    "Добрый день! Я разработчик (TypeScript, REST API Битрикс24), беру на субподряд задачи, которые обычно зависают у внедренцев: нестандартные импорты, парсинг источников, чистку дублей, синхронизации.",
    "",
    `Свежий кейс: база ${formatCount(stats.dealsScanned)} сделок, ${formatCount(stats.dealsKeyed)} переведено под ключ идемпотентности, ${formatCount(stats.duplicatePairsFound)} пар дублей в карантине, ноль ошибок API. Каждый запуск — сначала отчёт, запись после подтверждения.`,
    "",
    "Могу сделать бесплатный аудит дублей по базе любого вашего клиента — вам готовый повод продать доп. услугу. Удобно созвониться на 15 минут?"
  ].join("\n");
}

/** 4075 -> "4 075"; неразрывные пробелы Intl заменяем на обычные для WhatsApp. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replace(/[\u00A0\u202F]/g, " ");
}
