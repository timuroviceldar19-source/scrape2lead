import type { RegistryContact, RegistryContactLookup } from "../../bitrix/procurementCustomer.js";
import { normalizeRegistryPhones } from "../../bitrix/procurementCustomer.js";
import { zakupGet, type ZakupApiOptions } from "../zakupPublicApi.js";

const REGISTRY_PAGE_URL = "https://zakup.gov.kz/registry/pipp";

interface OrganizationSearchRow { id: number; iin_bin?: string | null }
interface OrganizationDetail {
  id: number;
  name_ru?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  addresses?: Array<{ phone?: string | null }> | null;
}

/**
 * Поиск организации по БИН в открытом реестре участников госзакупок.
 * Поиск `?q=` отдаёт массив без пагинации; совпадение берём строго по `iin_bin`.
 */
export function createZakupRegistryContactLookup(options: ZakupApiOptions = {}): RegistryContactLookup {
  return async (bin: string): Promise<RegistryContact | null> => {
    const found = await zakupGet<OrganizationSearchRow[] | { results?: OrganizationSearchRow[] }>(
      "/public/organizations/", { q: bin, limit: 20 }, options);
    const rows = Array.isArray(found) ? found : found?.results ?? [];
    const match = rows.find((row) => row.iin_bin === bin);
    if (!match) return null;
    const org = await zakupGet<OrganizationDetail>(`/public/organizations/${match.id}/`, {}, options);
    return {
      name: org.name_ru?.trim() || null,
      phones: normalizeRegistryPhones(org.phone, ...(org.addresses ?? []).map((address) => address.phone)),
      email: org.email?.trim() || null,
      website: org.website?.trim() || null,
      registryUrl: `${REGISTRY_PAGE_URL}/${match.id}`
    };
  };
}
