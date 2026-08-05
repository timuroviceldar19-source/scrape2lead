/**
 * Разбор серверной вёрстки goszakup.gov.kz для досье заказчика.
 *
 * Отличие от `goszakupHtmlParser`: тот работает по DOM, отрендеренному Playwright, и опирается на
 * `role="row"`, который DataTables проставляет уже в браузере. Здесь разбирается сырой ответ
 * обычного HTTP-запроса, поэтому строки и ячейки режутся толерантно — портал местами не закрывает
 * `<td>`, и regexp вида `<td>...</td>` на такой странице молча теряет колонки.
 */

export interface CustomerLot {
  lotNumber: string;
  lotName: string | null;
  lotId: string | null;
  announceId: string | null;
  announceNumber: string | null;
  announceName: string | null;
  customer: string | null;
  quantity: number | null;
  amount: number | null;
  method: string | null;
  status: string | null;
}

export interface AnnounceRepresentative {
  fullName: string;
  position: string | null;
  email: string | null;
}

export interface LotAward {
  lotId: string | null;
  lotNumber: string | null;
  lotName: string | null;
  contractNumber: string | null;
  contractKind: string | null;
  contractStatus: string | null;
  plannedAmount: number | null;
  contractAmount: number | null;
  supplierName: string | null;
  supplierBin: string | null;
  winnerStatus: string | null;
}

const LOT_COLUMNS = 7;
const AWARD_COLUMNS = 8;

export function parseCustomerLots(html: string): CustomerLot[] {
  const table = extractTableById(html, "search-result");
  if (!table) return [];

  const lots: CustomerLot[] = [];
  for (const row of splitRows(table)) {
    const cells = splitCells(row);
    if (cells.length < LOT_COLUMNS) continue;

    const lotNumber = cleanText(cells[0]);
    if (!lotNumber) continue;

    lots.push({
      lotNumber,
      lotName: strongText(cells[2]),
      lotId: attributeValue(cells[2], "data-lot-id"),
      announceId: firstMatch(cells[1], /\/announce\/index\/(\d+)/),
      announceNumber: firstMatch(cells[1], /<strong>\s*(\d+-\d+)/),
      announceName: strongText(cells[1]),
      customer: labelledText(cells[1], "Заказчик"),
      quantity: parseNumber(cells[3]),
      amount: parseNumber(cells[4]),
      method: cleanText(cells[5]) || null,
      status: cleanText(cells[6]) || null
    });
  }
  return lots;
}

export function parseAnnounceRepresentative(html: string): AnnounceRepresentative | null {
  const fullName = rowValue(html, "ФИО представителя");
  if (!fullName) return null;
  return {
    fullName,
    position: rowValue(html, "Должность"),
    email: rowValue(html, "E-Mail")
  };
}

/**
 * Вкладка «Договоры» объявления: заголовок с `data-id` задаёт лот, следующие строки — договоры по
 * нему. Плановая сумма против суммы договора показывает, насколько заказчик сбивает цену.
 */
export function parseAnnounceAwards(html: string): LotAward[] {
  const awards: LotAward[] = [];
  let currentLotId: string | null = null;
  let currentLotNumber: string | null = null;
  let currentLotName: string | null = null;

  for (const row of splitRows(html)) {
    const heading = parseLotHeading(row);
    if (heading) {
      currentLotId = heading.lotId;
      currentLotNumber = heading.lotNumber;
      currentLotName = heading.lotName;
      continue;
    }

    const cells = splitCells(row);
    if (cells.length < AWARD_COLUMNS) continue;

    awards.push({
      lotId: currentLotId,
      lotNumber: currentLotNumber,
      lotName: currentLotName,
      contractNumber: linkText(cells[0]),
      contractKind: tagText(cells[0], "small"),
      contractStatus: cleanText(cells[1]) || null,
      plannedAmount: parseNumber(cells[2]),
      contractAmount: parseNumber(cells[3]),
      supplierName: strongText(cells[5]),
      supplierBin: firstMatch(cells[6], /\b(\d{12})\b/),
      winnerStatus: cleanText(cells[7]) || null
    });
  }
  return awards;
}

function parseLotHeading(row: string): { lotId: string | null; lotNumber: string | null; lotName: string | null } | null {
  if (!/class="lot-links"/i.test(row)) return null;
  const text = cleanText(row);
  const match = text.match(/Лот\s*№\s*([^:]+):\s*(.*)$/);
  return {
    lotId: attributeValue(row, "data-id"),
    lotNumber: match ? match[1].trim() : null,
    lotName: match ? match[2].trim() || null : null
  };
}

/** Портал не закрывает часть `<td>`, поэтому границей ячейки считается следующий открывающий тег. */
function splitCells(rowHtml: string): string[] {
  return splitByOpeningTag(rowHtml, "td", "</td>");
}

function splitRows(html: string): string[] {
  return splitByOpeningTag(html, "tr", "</tr>");
}

function splitByOpeningTag(html: string, tag: string, closing: string): string[] {
  const chunks = html.split(new RegExp(`<${tag}[^>]*>`, "i")).slice(1);
  return chunks.map((chunk) => chunk.split(closing)[0] ?? chunk);
}

function extractTableById(html: string, id: string): string | null {
  const match = html.match(new RegExp(`<table[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/table>`, "i"));
  if (!match) return null;
  const body = match[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  return body ? body[1] : match[1];
}

function rowValue(html: string, label: string): string | null {
  const match = html.match(
    new RegExp(`<th[^>]*>\\s*${escapeRegex(label)}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i")
  );
  return match ? cleanText(match[1]) || null : null;
}

function strongText(html: string): string | null {
  return tagText(html, "strong");
}

function tagText(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(match[1]) || null : null;
}

function linkText(html: string): string | null {
  const match = html.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  return match ? cleanText(match[1]) || null : null;
}

function labelledText(html: string, label: string): string | null {
  const match = html.match(new RegExp(`<b>\\s*${escapeRegex(label)}:\\s*<\\/b>([^<]*)`, "i"));
  return match ? cleanText(match[1]) || null : null;
}

function attributeValue(html: string, attribute: string): string | null {
  return firstMatch(html, new RegExp(`${attribute}=['"]([^'"]+)['"]`, "i"));
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match ? match[1].trim() || null : null;
}

function parseNumber(html: string): number | null {
  const text = cleanText(html).replace(/\s/g, "").replace(/,/g, ".");
  if (!/\d/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function cleanText(input: string): string {
  return decodeEntities(input.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
