import type { ProcurementRecord } from "./types.js";

export function procurementCustomerUrl(record: ProcurementRecord): string | undefined {
  const organizationId = record.customerSourceId?.trim();
  if (!organizationId || !/^\d+$/.test(organizationId)) return undefined;
  return `https://zakup.gov.kz/registry/pipp/${organizationId}`;
}
