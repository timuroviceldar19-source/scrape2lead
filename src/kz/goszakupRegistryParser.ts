import type { GoszakupRegistryRecord } from "./registryTypes.js";

export function parseRegistrySearchHtml(html: string, bin: string): { participant_id: string; profile_url: string } | null {
  const binPattern = bin.replace(/\D/g, "");
  const rows = extractTableRows(html);

  for (const row of rows) {
    const cells = extractCells(row);
    const binCell = cells.find((cell) => cell.replace(/\s/g, "") === binPattern);
    if (!binCell) continue;

    const linkMatch = row.match(/show_supplier\/(\d+)/);
    if (linkMatch) {
      return {
        participant_id: linkMatch[1],
        profile_url: `https://goszakup.gov.kz/ru/registry/show_supplier/${linkMatch[1]}`
      };
    }
  }

  const fallbackRegex = new RegExp(`show_supplier/(\\d+)[\\s\\S]{0,200}?${binPattern}|${binPattern}[\\s\\S]{0,200}?show_supplier/(\\d+)`, "i");
  const fallbackMatch = html.match(fallbackRegex);
  if (fallbackMatch) {
    const pid = fallbackMatch[1] ?? fallbackMatch[2];
    return {
      participant_id: pid,
      profile_url: `https://goszakup.gov.kz/ru/registry/show_supplier/${pid}`
    };
  }

  return null;
}

export function parseRegistryProfileHtml(html: string, bin: string): GoszakupRegistryRecord | null {
  const fields = extractProfileFields(html);

  const foundBin = findFieldValue(fields, ["БИН участника", "БИН"]);
  if (foundBin && foundBin.replace(/\s/g, "") !== bin.replace(/\s/g, "")) {
    return null;
  }

  const nameRu = findFieldValue(fields, ["Наименование на рус. языке", "Наименование на русском языке", "Наименование (рус)"]);
  const nameKz = findFieldValue(fields, ["Наименование на каз. языке", "Наименование на казахском языке", "Наименование (каз)"]);
  const rnn = findFieldValue(fields, ["РНН участника", "РНН"]);
  const role = findFieldValue(fields, ["Роли участника", "Роль участника", "Роли"]);
  const residency = findFieldValue(fields, ["Резидентство", "Резидент"]);
  const email = findFieldValue(fields, ["E-Mail", "E-mail", "Email"]);
  const phoneRaw = findFieldValue(fields, ["Контактный телефон", "Телефон"]);
  const websiteRaw = findFieldValue(fields, ["Веб-сайт", "Сайт"]);
  const registrationDate = findFieldValue(fields, ["Дата регистрации"]);
  const lastUpdateDate = findFieldValue(fields, ["Дата последнего обновления"]);
  const kopf = findFieldValue(fields, ["КОПФ", "Организационно-правовая форма"]);
  const ownershipForm = findFieldValue(fields, ["Форма собственности"]);
  const economicSector = findFieldValue(fields, ["Сектор экономики"]);
  const okedList = findFieldValue(fields, ["ОКЭД", "ОКЭД(ы)", "Виды экономической деятельности"]);

  const directorName = findSectionValue(html, "Руководитель", ["ФИО", "Фамилия, имя, отчество", "Ф.И.О"]);
  const directorIin = findSectionValue(html, "Руководитель", ["ИИН", "ИИН руководителя"]);

  const reportingAdministrator = findFieldValue(fields, [
    "Наименование администратора(ов) отчетности",
    "Наименование Администратора отчетности",
    "Администратор отчетности"
  ]);

  const contactAddresses = extractContactAddresses(html);
  const legalAddress = findAddressValue(html, ["Юридический адрес", "Юр. адрес"]) ?? contactAddresses.legal_address;
  const locationAddress = findAddressValue(html, ["Адрес местонахождения", "Фактический адрес"])
    ?? contactAddresses.location_address;
  const fullAddressRu = contactAddresses.full_address_ru ?? legalAddress;

  const participantMatch = html.match(/show_supplier\/(\d+)/);
  const participantId = participantMatch?.[1] ?? null;

  return {
    bin: foundBin?.replace(/\s/g, "") ?? bin,
    participant_id: participantId,
    name_ru: nullable(nameRu),
    name_kz: nullable(nameKz),
    rnn: nullable(rnn),
    role: nullable(role),
    residency: nullable(residency),
    phone: normalizePhone(phoneRaw),
    email: nullable(email),
    website: normalizeWebsite(websiteRaw),
    registration_date: normalizeDateToIso(registrationDate),
    last_update_date: normalizeDateToIso(lastUpdateDate),
    kopf: nullable(kopf),
    ownership_form: nullable(ownershipForm),
    economic_sector: nullable(economicSector),
    oked_list: nullable(okedList),
    director_name: nullable(directorName),
    director_iin: nullable(directorIin),
    legal_address: nullable(legalAddress),
    location_address: nullable(locationAddress),
    full_address_ru: nullable(fullAddressRu),
    reporting_administrator: nullable(reportingAdministrator),
    registry_url: participantId ? `https://goszakup.gov.kz/ru/registry/show_supplier/${participantId}` : null,
    updated_at: new Date().toISOString(),
    raw_snapshot_path: null
  };
}

function extractTableRows(html: string): string[] {
  const rows: string[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(html)) !== null) {
    rows.push(match[1]);
  }
  return rows;
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    cells.push(cleanHtmlText(match[1]));
  }
  return cells;
}

interface ProfileField {
  label: string;
  value: string;
}

function extractProfileFields(html: string): ProfileField[] {
  const fields: ProfileField[] = [];

  const divCellRegex = /<div\s+class=["']divTableCell["'][^>]*>([\s\S]*?)<\/div>/gi;
  const cells: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = divCellRegex.exec(html)) !== null) {
    cells.push(cleanHtmlText(match[1]));
  }
  for (let i = 0; i < cells.length - 1; i += 2) {
    fields.push({ label: cells[i], value: cells[i + 1] ?? "" });
  }

  const thTdRegex = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  while ((match = thTdRegex.exec(html)) !== null) {
    fields.push({ label: cleanHtmlText(match[1]), value: cleanHtmlText(match[2]) });
  }

  const labelValueRegex = /<div[^>]*class=["'][^"']*label[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=["'][^"']*value[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  while ((match = labelValueRegex.exec(html)) !== null) {
    fields.push({ label: cleanHtmlText(match[1]), value: cleanHtmlText(match[2]) });
  }

  return fields;
}

function findFieldValue(fields: ProfileField[], labels: string[]): string | null {
  for (const field of fields) {
    const normalizedLabel = normalizeLabel(field.label);
    for (const label of labels) {
      if (normalizedLabel === normalizeLabel(label) || normalizedLabel.includes(normalizeLabel(label))) {
        return field.value || null;
      }
    }
  }
  return null;
}

function findSectionValue(html: string, sectionName: string, fieldLabels: string[]): string | null {
  const sectionRegex = new RegExp(`${escapeRegex(sectionName)}[\\s\\S]*?(?=<div[^>]*class=["'][^"']*section|$)`, "i");
  const sectionMatch = html.match(sectionRegex);
  if (!sectionMatch) return null;

  const sectionHtml = sectionMatch[0];
  const fields = extractProfileFields(sectionHtml);
  return findFieldValue(fields, fieldLabels);
}

function findAddressValue(html: string, addressLabels: string[]): string | null {
  const fields = extractProfileFields(html);
  return findFieldValue(fields, addressLabels);
}

export function extractContactAddresses(html: string): {
  legal_address: string | null;
  location_address: string | null;
  full_address_ru: string | null;
} {
  const empty = { legal_address: null, location_address: null, full_address_ru: null };
  const sectionMatch = html.match(/Контактная информация[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!sectionMatch) return empty;

  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(sectionMatch[1])) !== null) {
    const cells: string[] = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cleanHtmlText(cellMatch[1]));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length < 2) return empty;

  const header = rows[0];
  const addressIdx = header.findIndex((cell) => /полный адрес\(рус\)/i.test(cell));
  const typeIdx = header.findIndex((cell) => /тип адреса/i.test(cell));
  if (addressIdx < 0) return empty;

  let legal: string | null = null;
  let location: string | null = null;
  let primary: string | null = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const address = row[addressIdx]?.trim() || null;
    if (!address) continue;

    const type = typeIdx >= 0 ? (row[typeIdx]?.trim().toLocaleLowerCase("ru") ?? "") : "";
    if (!primary) primary = address;
    if (type.includes("юридическ")) legal = address;
    if (type.includes("местонахожд") || type.includes("фактическ")) location = address;
  }

  return {
    legal_address: legal ?? primary,
    location_address: location,
    full_address_ru: primary
  };
}

function normalizeLabel(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function cleanHtmlText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
}

function nullable(value: string | null): string | null {
  return value && value.trim() ? value.trim() : null;
}

export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const candidates = raw.split(/[,;/]/);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const digits = trimmed.replace(/[^\d]/g, "");
    if (!digits) continue;
    let normalized: string | null = null;
    if (trimmed.startsWith("+")) {
      const afterPlus = digits;
      if (afterPlus.length === 12 && afterPlus.startsWith("7")) {
        normalized = `+${afterPlus}`;
      } else if (afterPlus.length === 11 && afterPlus.startsWith("7")) {
        normalized = `+${afterPlus}`;
      }
    } else if (digits.length === 11 && digits.startsWith("8")) {
      normalized = `+7${digits.slice(1)}`;
    } else if (digits.length === 11 && digits.startsWith("7")) {
      normalized = `+${digits}`;
    } else if (digits.length === 10) {
      normalized = `+7${digits}`;
    }
    if (normalized && normalized.length === 12 && !PHONE_EXCLUDED_NUMBERS.has(normalized)) {
      return normalized;
    }
    if (
      digits.length >= 5
      && digits.length <= 9
      && /^[+\d()\s.-]+$/.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return null;
}

const PHONE_EXCLUDED_NUMBERS = new Set(["+77172735515"]);

const WEBSITE_PLACEHOLDERS = new Set([
  "-",
  "—",
  "нет",
  "n/a",
  "отсутствует",
  "вЂ”",
  "РЅРµС‚",
  "РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚"
]);
const WEBSITE_EXCLUDED_HOSTS = new Set([
  "satypalu.gov.kz",
  "www.satypalu.gov.kz",
  "goszakup.gov.kz",
  "www.goszakup.gov.kz"
]);

export function normalizeWebsite(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return null;
  if (WEBSITE_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  let url = trimmed;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (hostname.length < 4) return null;
    if (!hostname.includes(".")) return null;
    if (WEBSITE_EXCLUDED_HOSTS.has(hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeDateToIso(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return value;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
