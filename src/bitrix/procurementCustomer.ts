import type { ProcurementRecord } from "../kz/procurement/types.js";
import { PROCUREMENT_ORIGINATOR_ID } from "./procurementDealPlan.js";

/** То же поле «БИН заказчика», по которому GZ-сборщик ищет и создаёт компании. */
export const COMPANY_BIN_FIELD = "UF_CRM_666171B20E9E3";

/** Контакты организации из реестра участников госзакупок (zakup.gov.kz). */
export interface RegistryContact {
  name: string | null;
  phones: string[];
  email: string | null;
  website: string | null;
  registryUrl: string | null;
}

export type RegistryContactLookup = (bin: string) => Promise<RegistryContact | null>;

export interface ProcurementCustomerClient {
  findCompanyByBin(bin: string): Promise<string | null>;
  findCompanyByOrigin(originatorId: string, originId: string): Promise<string | null>;
  addCompany(fields: Record<string, unknown>): Promise<string>;
}

export interface ProcurementCustomerResolution {
  action: "none" | "existing" | "create";
  /** null в dry-run: компания была бы создана, но запись не выполнялась. */
  companyId: string | null;
  warning: string | null;
}

export type ProcurementCustomerResolver = (record: ProcurementRecord) => Promise<ProcurementCustomerResolution>;

const MIN_PHONE_DIGITS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function procurementCompanyOriginId(bin: string): string {
  return `procurement-company:${bin}`;
}

export function normalizeBin(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

/** Реестр хранит телефоны как свободный текст: «57-97-96; 57-93-59», «7051641446», «нет». */
export function normalizeRegistryPhones(...values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const phones: string[] = [];
  for (const part of values.flatMap((value) => String(value ?? "").split(/[;,]/))) {
    const trimmed = part.trim();
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < MIN_PHONE_DIGITS || seen.has(digits)) continue;
    seen.add(digits);
    phones.push(/^7\d{9}$/.test(trimmed) ? `+7${trimmed}` : trimmed);
  }
  return phones;
}

function validEmail(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

export function buildProcurementCompanyFields(record: ProcurementRecord, contact: RegistryContact | null): Record<string, unknown> {
  const bin = normalizeBin(record.customerBin) ?? "";
  const comments = [`БИН: ${bin}`, "Источник контактов: реестр участников госзакупок",
    contact?.registryUrl ?? null].filter(Boolean).join("\n");
  const fields: Record<string, unknown> = {
    TITLE: record.customerName?.trim() || contact?.name?.trim() || bin,
    COMPANY_TYPE: "CUSTOMER",
    OPENED: "Y",
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead procurement",
    ORIGINATOR_ID: PROCUREMENT_ORIGINATOR_ID,
    ORIGIN_ID: procurementCompanyOriginId(bin),
    [COMPANY_BIN_FIELD]: bin,
    COMMENTS: comments
  };
  const phones = contact?.phones ?? [];
  if (phones.length) fields.PHONE = phones.map((value) => ({ VALUE: value, VALUE_TYPE: "WORK" }));
  const email = validEmail(contact?.email ?? null);
  if (email) fields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
  if (contact?.website?.trim()) fields.WEB = [{ VALUE: contact.website.trim(), VALUE_TYPE: "WORK" }];
  return fields;
}

/**
 * Находит компанию заказчика по БИН (или созданную этим сборщиком раньше), иначе создаёт её
 * с контактами из реестра. Один БИН за прогон обрабатывается один раз, даже при параллельных вызовах.
 */
export function createProcurementCustomerResolver(
  client: ProcurementCustomerClient,
  lookupContact: RegistryContactLookup,
  options: { execute: boolean }
): ProcurementCustomerResolver {
  const byBin = new Map<string, Promise<ProcurementCustomerResolution>>();
  return async (record) => {
    const bin = normalizeBin(record.customerBin);
    if (!bin) return { action: "none", companyId: null, warning: null };
    let pending = byBin.get(bin);
    if (!pending) {
      pending = resolveByBin(record, bin);
      byBin.set(bin, pending);
    }
    return await pending;
  };

  async function resolveByBin(record: ProcurementRecord, bin: string): Promise<ProcurementCustomerResolution> {
    const existing = await client.findCompanyByBin(bin)
      ?? await client.findCompanyByOrigin(PROCUREMENT_ORIGINATOR_ID, procurementCompanyOriginId(bin));
    if (existing) return { action: "existing", companyId: existing, warning: null };

    let contact: RegistryContact | null = null;
    let warning: string | null = null;
    try {
      contact = await lookupContact(bin);
      if (!contact) warning = `registry: организация ${bin} не найдена, компания без телефона`;
      else if (!contact.phones.length) warning = `registry: у организации ${bin} нет телефона`;
    } catch (error) {
      warning = `registry: ${error instanceof Error ? error.message : String(error)}`;
    }
    const fields = buildProcurementCompanyFields(record, contact);
    const companyId = options.execute ? await client.addCompany(fields) : null;
    return { action: "create", companyId, warning };
  }
}
