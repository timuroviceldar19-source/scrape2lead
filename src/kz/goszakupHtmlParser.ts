import { GZ_PORTAL_ORIGIN } from "./goszakupOrigin.js";

export interface GoszakupAnnounceItem {
  number: string;
  name: string;
  organizer: string | null;
  method: string | null;
  application_start: string | null;
  application_end: string | null;
  amount: string | null;
  status: string | null;
  lots_count: number | null;
  announce_id: string | null;
}

export interface GoszakupLotItem {
  lot_number: string;
  lot_name: string | null;
  announce_number: string | null;
  announce_name: string | null;
  customer: string | null;
  quantity: string | null;
  amount: string | null;
  method: string | null;
  status: string | null;
  lot_id: string | null;
  trd_buy_id: string | null;
  lot_url: string | null;
  announce_url: string | null;
  customer_url: string | null;
}

export interface GoszakupContractItem {
  contract_id: string;
  contract_number: string;
  purchase_number: string | null;
  contract_type: string | null;
  status: string | null;
  created_at: string | null;
  amount: string | null;
  customer: string | null;
  supplier: string | null;
  method: string | null;
  url: string | null;
}

export function parseGoszakupAnnounceHtml(html: string): GoszakupAnnounceItem[] {
  const rows = extractTableRows(html, "search-result");
  const items: GoszakupAnnounceItem[] = [];

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 7) continue;

    const numberMatch = row.match(/<strong>(\d+-\d+)<\/strong>/);
    if (!numberMatch) continue;

    const announceIdMatch = row.match(/\/announce\/index\/(\d+)/);

    const lotsCountMatch = cells[0].match(/Лотов:\s*(\d+)/i);

    items.push({
      number: numberMatch[1],
      name: cleanText(cells[1].replace(/<[\s\S]*?>/g, " ").replace(/\s+/g, " ").trim()),
      organizer: extractLabelValue(cells[1], "Организатор"),
      method: cleanText(cells[2]) || null,
      application_start: parseDateTime(cells[3]),
      application_end: parseDateTime(cells[4]),
      amount: extractStrongText(cells[5]),
      status: cleanText(cells[6]) || null,
      lots_count: lotsCountMatch ? Number(lotsCountMatch[1]) : null,
      announce_id: announceIdMatch?.[1] ?? null
    });
  }

  return items;
}

export function parseGoszakupLotsHtml(html: string): GoszakupLotItem[] {
  const rows = extractTableRows(html, "search-result");
  const items: GoszakupLotItem[] = [];

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 7) continue;

    const lotNumberMatch = cells[0].match(/<strong>([^<]+)<\/strong>/);
    if (!lotNumberMatch) continue;

    const announceUrl = extractFirstHref(cells[1]);
    const lotUrl = extractFirstHref(cells[2]);
    const customerUrl = extractCustomerUrl(cells[1]);
    const announceLinkMatch = cells[1].match(/\/announce\/index\/(\d+)/);
    const announceNumberMatch = cells[1].match(/<strong>(\d+-\d+)\s/);
    const lotIdMatch = row.match(/data-lot-id="(\d+)"/);
    const trdBuyIdMatch = row.match(/data-trb-buy="(\d+)"/);

    items.push({
      lot_number: lotNumberMatch[1].trim(),
      lot_name: extractStrongText(cells[2]) ?? extractLinkText(cells[2]),
      announce_number: announceNumberMatch?.[1] ?? null,
      announce_name: extractAnnounceName(cells[1]),
      customer: extractLabelValue(cells[1], "Заказчик"),
      quantity: cleanText(cells[3]) || null,
      amount: extractStrongText(cells[4]),
      method: cleanText(cells[5]) || null,
      status: cleanText(cells[6]) || null,
      lot_id: lotIdMatch?.[1] ?? null,
      trd_buy_id: trdBuyIdMatch?.[1] ?? announceLinkMatch?.[1] ?? null,
      lot_url: lotUrl,
      announce_url: announceUrl,
      customer_url: customerUrl
    });
  }

  return items;
}

export function parseGoszakupContractHtml(html: string): GoszakupContractItem[] {
  const rows = extractTableRows(html, "search-result");
  const items: GoszakupContractItem[] = [];

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 10) continue;

    const contractId = cleanText(cells[0]);
    if (!contractId || !/^\d+$/.test(contractId)) continue;

    const urlMatch = cells[1].match(/href="([^"]+)"/);

    items.push({
      contract_id: contractId,
      contract_number: cleanText(cells[1].replace(/<[^>]*>/g, "")) || contractId,
      purchase_number: cleanText(cells[2]) || null,
      contract_type: cleanText(cells[3]) || null,
      status: cleanText(cells[4]) || null,
      created_at: cleanText(cells[5]) || null,
      amount: extractStrongText(cells[6]),
      customer: cleanText(cells[7]) || null,
      supplier: cleanText(cells[8]) || null,
      method: cleanText(cells[9]) || null,
      url: urlMatch?.[1] ?? null
    });
  }

  return items;
}

export function parseGoszakupPagination(html: string): { currentPage: number; totalPages: number; totalCount: number } {
  const pageLinks = html.match(/page=(\d+)/g) ?? [];
  let maxPage = 0;
  for (const link of pageLinks) {
    const num = Number(link.replace("page=", ""));
    if (num > maxPage) maxPage = num;
  }

  const countMatch = html.match(/count_record=(\d+)/);
  const countRecord = countMatch ? Number(countMatch[1]) : 50;

  const infoMatch = html.match(/infoFiltered.*?\(найдено из (\d+)/);
  const recordsMatch = html.match(/из\s+(\d+)\s+записей/i);
  const totalCount = infoMatch
    ? Number(infoMatch[1])
    : recordsMatch
      ? Number(recordsMatch[1])
      : 0;

  const totalPages = maxPage > 0
    ? maxPage + 1
    : totalCount > 0
      ? Math.ceil(totalCount / countRecord)
      : 1;

  return {
    currentPage: 0,
    totalPages,
    totalCount
  };
}

function extractTableRows(html: string, tableId: string): string[] {
  const tableRegex = new RegExp(`<table[^>]*id="${tableId}"[^>]*>([\\s\\S]*?)<\\/table>`, "i");
  const tableMatch = html.match(tableRegex);
  if (!tableMatch) return [];

  const tbodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const body = tbodyMatch ? tbodyMatch[1] : tableMatch[1];

  const rows: string[] = [];
  const rowRegex = /<tr[^>]*role="row"[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(body)) !== null) {
    if (match[1].includes("dataTables_empty")) continue;
    rows.push(match[1]);
  }
  return rows;
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    cells.push(match[1]);
  }
  return cells;
}

function cleanText(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function extractStrongText(input: string): string | null {
  const match = input.match(/<strong>([^<]+)<\/strong>/);
  return match ? decodeEntities(match[1]).trim() : null;
}

function extractLinkText(input: string): string | null {
  const match = input.match(/<a[^>]*>([^<]+)<\/a>/);
  return match ? decodeEntities(match[1]).trim() : null;
}

function extractFirstHref(input: string): string | null {
  const match = input.match(/href="([^"]+)"/i);
  if (!match) return null;
  return normalizeGoszakupUrl(decodeEntities(match[1]).trim());
}

function extractCustomerUrl(input: string): string | null {
  const matches = [...input.matchAll(/href="([^"]+)"/gi)];
  const match = matches.find((item) => item[1].includes("/registry/show_supplier/"));
  if (!match) return null;
  return normalizeGoszakupUrl(decodeEntities(match[1]).trim());
}

function normalizeGoszakupUrl(url: string): string {
  if (url.startsWith("http")) return url;
  return `${GZ_PORTAL_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

function extractAnnounceName(cellHtml: string): string | null {
  const match = cellHtml.match(/<strong>\d+-\d+\s+([^<]+)<\/strong>/);
  return match ? decodeEntities(match[1]).trim() : null;
}

function extractLabelValue(cellHtml: string, label: string): string | null {
  const regex = new RegExp(`<b>${label}:<\\/b>\\s*([^<]+)`, "i");
  const match = cellHtml.match(regex);
  return match ? decodeEntities(match[1]).trim() : null;
}

function parseDateTime(cellHtml: string): string | null {
  const cleaned = cellHtml.replace(/<br\s*\/?>/g, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const match = cleaned.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : cleaned || null;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}
