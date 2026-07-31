const GOSZAKUP_ORIGIN = "https://www.goszakup.gov.kz";

export interface ContractSearchItem {
  contractId: string;
  contractNumber: string;
  url: string;
  amount: number;
}

export interface ContractSearchResult {
  items: ContractSearchItem[];
  pagination: { totalCount: number; totalPages: number };
}

export interface ContractParties {
  customerBin: string;
  customerName: string;
  supplierBinIin: string;
  supplierName: string;
}

export function parseContractSearchHtml(html: string, recordsPerPage: number): ContractSearchResult {
  const table = extractTable(html, "search-result");
  const items: ContractSearchItem[] = [];
  for (const row of extractRows(table)) {
    const cells = extractCells(row);
    if (cells.length < 2) continue;
    const contractId = cleanText(cells[0]);
    const href = extractHref(cells[1]);
    if (!/^\d+$/.test(contractId) || !href) continue;
    items.push({
      contractId,
      contractNumber: cleanText(cells[1]) || contractId,
      url: normalizeUrl(href),
      amount: parseAmount(cleanText(cells[6] ?? ""))
    });
  }

  const totalMatch = cleanText(html).match(/(?:Показано\s+[сc]\s+\d+\s+по\s+\d+\s+из|из)\s+([\d\s]+)\s+запис/i);
  const totalCount = totalMatch ? Number(totalMatch[1].replace(/\s/g, "")) : items.length;
  return {
    items,
    pagination: {
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / recordsPerPage))
    }
  };
}

function parseAmount(value: string): number {
  const normalized = value.replace(/\s/g, "").replace(",", ".").replace(/[^0-9.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseContractGeneralHtml(html: string): { signedAt: string | null } {
  return { signedAt: findTableValue(html, "Дата заключения договора") };
}

export function parseContractUnitsHtml(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(/\b\d{6}\.\d{3}\.\d{6}\b/g)) seen.add(match[0]);
  return [...seen];
}

export function parseContractUnitNamesHtml(html: string): Array<{ code: string; name: string }> {
  const result: Array<{ code: string; name: string }> = [];
  for (const row of extractRows(html)) {
    const cells = extractCells(row).map(cleanText);
    const code = cells.find((cell) => /^\d{6}\.\d{3}\.\d{6}$/.test(cell));
    if (!code) continue;
    const codeIndex = cells.indexOf(code);
    result.push({ code, name: cells[codeIndex + 1] || "" });
  }
  return result;
}

export function parseContractPartiesHtml(html: string): ContractParties {
  const customer = extractHeadingSection(html, "Заказчик", "Поставщик");
  const supplier = extractHeadingSection(html, "Поставщик");
  const customerBin = validIdentifier(findTableValue(customer, "БИН"));
  const supplierBin = validIdentifier(findTableValue(supplier, "БИН"));
  const supplierIin = validIdentifier(findTableValue(supplier, "ИИН"));
  return {
    customerBin,
    customerName: findTableValue(customer, "Наименование заказчика (на русском языке)") ?? "",
    supplierBinIin: supplierBin || supplierIin,
    supplierName: findTableValue(supplier, "Наименование поставщика (на русском языке)") ?? ""
  };
}

function extractTable(html: string, id: string): string {
  return html.match(new RegExp(`<table[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/table>`, "i"))?.[1] ?? "";
}

function extractRows(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
}

function extractCells(html: string): string[] {
  return [...html.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((match) => match[1]);
}

function extractHref(html: string): string | null {
  return html.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
}

function normalizeUrl(url: string): string {
  const decoded = decodeEntities(url.trim());
  if (/^https?:\/\//i.test(decoded)) return decoded;
  return `${GOSZAKUP_ORIGIN}${decoded.startsWith("/") ? "" : "/"}${decoded}`;
}

function findTableValue(html: string, label: string): string | null {
  for (const row of extractRows(html)) {
    const cells = extractCells(row);
    if (cells.length >= 2 && cleanText(cells[0]) === label) return cleanText(cells[1]) || null;
  }
  return null;
}

function extractHeadingSection(html: string, start: string, end?: string): string {
  const startPattern = new RegExp(`<h[1-6][^>]*>\\s*${escapeRegExp(start)}\\s*<\\/h[1-6]>`, "i");
  const match = startPattern.exec(html);
  if (!match) return "";
  const tail = html.slice(match.index + match[0].length);
  if (!end) return tail;
  const endPattern = new RegExp(`<h[1-6][^>]*>\\s*${escapeRegExp(end)}\\s*<\\/h[1-6]>`, "i");
  const endMatch = endPattern.exec(tail);
  return endMatch ? tail.slice(0, endMatch.index) : tail;
}

function validIdentifier(value: string | null): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return /^\d{12}$/.test(digits) ? digits : "";
}

function cleanText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#0*39;|&apos;/gi, "'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
