export interface AnnounceCustomer {
  bin: string;
  name: string | null;
  legalAddress: string | null;
}

/**
 * Lot search results do not expose the customer BIN. The announcement page
 * (/ru/announce/index/<id>) carries it in the "Организатор" row as
 * `<th>Организатор</th><td>020840001842 Наименование</td>`.
 */
export function parseAnnounceCustomer(html: string): AnnounceCustomer | null {
  const organizer = extractRowValue(html, "Организатор");
  if (!organizer) return null;

  const binMatch = organizer.match(/\b\d{12}\b/);
  if (!binMatch) return null;
  const bin = binMatch[0];
  const name = organizer.replace(bin, "").replace(/\s+/g, " ").trim() || null;

  const legalAddress = extractRowValue(html, "Юр. адрес организатора");

  return { bin, name, legalAddress };
}

function extractRowValue(html: string, label: string): string | null {
  const pattern = new RegExp(
    `<th[^>]*>\\s*${escapeRegex(label)}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    "i"
  );
  const match = html.match(pattern);
  if (!match) return null;
  return cleanHtmlText(match[1]) || null;
}

function cleanHtmlText(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
