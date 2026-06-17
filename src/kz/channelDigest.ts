import type { OutreachWinner } from "./outreachDigest.js";
import { formatTengeShort } from "./outreachMessages.js";

export interface ChannelDigestOptions {
  /** Сколько победителей показать в публичном посте (default 10). */
  maxRows?: number;
  /** Заголовок ниши недели, например «Строительство» или «ПСД / освещение». */
  nicheLabel?: string;
  /** Ссылка на канал для демо. */
  channelUrl?: string;
  /** Подпись к счётчику в футере (default: «новых победителей»). */
  countLabel?: string;
}

const DEFAULT_CHANNEL_URL = "https://t.me/ai_leads_kz";
const DEFAULT_WHATSAPP_URL =
  "https://wa.me/77009781336?text=Привет!%20Интересуют%20лиды%20goszakup";
const INSTAGRAM_URL = "https://www.instagram.com/ai.leads.kz/";
const THREADS_URL = "https://www.threads.com/@ai.leads.kz";
const SEPARATOR = "────────────────";

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** ТОО "Lion's group" → Lion's group */
export function formatCompanyShort(name: string, maxLen = 38): string {
  let short = name.trim();
  const patterns = [
    /^товарищество\s+с\s+ограниченной\s+ответственностью\s*["«]?/i,
    /^корпорация\s*["«]?/i,
    /^ТОО\s*["«]?/i,
    /^АО\s*["«]?/i,
    /^ИП\s+/i
  ];
  for (const pattern of patterns) {
    short = short.replace(pattern, "");
  }
  short = short.replace(/^["«]+/, "").replace(/["»]+$/g, "").trim();
  if (!short) short = name.trim();
  return truncate(short, maxLen);
}

function formatDigestDate(date = new Date()): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatAmount(winner: OutreachWinner): string {
  if (winner.amount !== null && winner.amount > 0) return formatTengeShort(winner.amount);
  if (winner.amount_raw?.trim()) return `${winner.amount_raw.trim()} ₸`;
  return "—";
}

function formatWinnerBlock(winner: OutreachWinner, index: number): string {
  const company = escapeHtml(formatCompanyShort(winner.company_name));
  const subject = escapeHtml(truncate(winner.contract_name || winner.contract_number, 88));
  const amount = escapeHtml(formatAmount(winner));
  const customer = winner.customer_name?.trim();
  const link = winner.url?.trim();

  const lines = [
    `<b>${index}.</b> <b>${company}</b>`,
    `📋 ${subject}`,
    `💰 <b>${amount}</b>`
  ];

  if (customer) {
    lines.push(`🏛 ${escapeHtml(truncate(customer, 52))}`);
  }
  if (link) {
    lines.push(`🔗 <a href="${escapeHtml(link)}">goszakup</a>`);
  }

  return lines.join("\n");
}

/**
 * Публичный дайджест для Telegram-канала (HTML).
 * Без телефонов и email — только компания, предмет, сумма, ссылка на goszakup.
 */
export function formatChannelDigest(
  winners: OutreachWinner[],
  options: ChannelDigestOptions = {}
): string | null {
  const maxRows = options.maxRows ?? 10;
  const rows = winners.slice(0, maxRows);
  if (rows.length === 0) return null;

  const dateLabel = formatDigestDate();
  const niche = options.nicheLabel?.trim();
  const title = niche ? `Дайджест goszakup · ${escapeHtml(niche)}` : "Дайджест победителей goszakup";

  const channelUrl = options.channelUrl?.trim() || DEFAULT_CHANNEL_URL;
  const countLabel = escapeHtml(options.countLabel?.trim() || "новых победителей");

  const header = [`<b>📊 ${title}</b>`, `<i>${dateLabel} · Казахстан</i>`, SEPARATOR].join("\n");

  const body = rows
    .map((winner, index) => {
      const block = formatWinnerBlock(winner, index + 1);
      return index < rows.length - 1 ? `${block}\n${SEPARATOR}` : block;
    })
    .join("\n");

  const footer = [
    "",
    SEPARATOR,
    `<i>Показано ${rows.length} из ${winners.length} · ${countLabel}</i>`,
    "Телефоны и полный Excel — в личку или платном пакете.",
    "",
    `📎 <a href="${escapeHtml(channelUrl)}">Демо Excel</a> <i>(~50 строк, контакты замаскированы)</i>`,
    `💬 <a href="${DEFAULT_WHATSAPP_URL}">Заказать список под нишу</a>`,
    "",
    `<a href="${escapeHtml(INSTAGRAM_URL)}">Instagram</a> · <a href="${escapeHtml(THREADS_URL)}">Threads</a>`
  ].join("\n");

  return [header, "", body, footer].join("\n");
}

/** Telegram HTML parse_mode для дайджеста канала. */
export const CHANNEL_DIGEST_PARSE_MODE = "HTML" as const;
