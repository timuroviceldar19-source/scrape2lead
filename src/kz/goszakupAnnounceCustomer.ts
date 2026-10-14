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

export interface AnnounceRepresentative {
  fullName: string | null;
  position: string | null;
  email: string | null;
}

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Contact person of the organizer. The announcement page lists it in the
 * "Информация об организаторе" block as rows `ФИО представителя`, `Должность`
 * and `E-Mail`; the customer's phone is not published there. Rows that the
 * portal keeps commented out in the markup are ignored.
 */
export function parseAnnounceRepresentative(html: string): AnnounceRepresentative | null {
  const visible = html.replace(/<!--[\s\S]*?-->/g, "");
  const fullName = extractRowValue(visible, "ФИО представителя");
  const position = extractRowValue(visible, "Должность");
  const rawEmail = extractRowValue(visible, "E-Mail")?.toLowerCase() ?? null;
  const email = rawEmail && EMAIL_PATTERN.test(rawEmail) ? rawEmail : null;

  if (!fullName && !position && !email) return null;
  return { fullName, position, email };
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
