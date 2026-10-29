import fs from "node:fs";
import path from "node:path";
import { mapWithConcurrency, zakupGet, zakupListAll, type ZakupApiOptions } from "../zakupPublicApi.js";
import { classifyCode, isExcludedStatus, loadMarketConfig } from "./config.js";
import { filterContractUnits, type RawContractItem, type RawContractUnit } from "./filterUnits.js";
import type { MarketConfig, MarketUnit } from "./types.js";

/** БИН организаций по их id на платформе: в списке договоров есть только id, а за БИН нужен отдельный запрос. */
export const DEFAULT_ORG_CACHE_PATH = "data/market/orgs.json";

/** Старый портал (ЭГЗ). Кэш рынка собран по нему, другие системы платформы в него не входят. */
const GOSZAKUP_SYSTEM_ID = 1;
/** «Товар» в справочнике предметов закупки. */
const GOODS_SUBJECT_ID = 1;

interface ZakupDictItem {
  id: number;
  egz_code?: string | null;
}

interface ZakupContract {
  id: number;
  external_id?: number | string | null;
  sign_date?: string | null;
  status_id?: number | null;
  actual_purchase_method?: { id?: number | null } | null;
  purchase_method_id?: number | null;
  contract_price_with_vat?: number | null;
  enstru_code?: string[] | null;
  supplier_organization_id?: number | null;
  supplier_organization_name?: string | null;
  customer_organization_id?: number | null;
  customer_organization_name?: string | null;
}

interface ZakupSubject {
  external_id?: number | string | null;
  timestamp?: number | null;
  item_price_without_vat?: number | null;
  quantity?: number | null;
  contract_price_without_vat?: number | null;
  purchase_total_price_without_vat?: number | null;
  plan_item?: { enstru?: { code?: string | null } | null } | null;
}

interface ZakupContractDetail {
  supplier_organization?: { id?: number | null; iin_bin?: string | null } | null;
  customer_organization?: { id?: number | null; iin_bin?: string | null } | null;
}

export interface FetchZakupMarketOptions extends ZakupApiOptions {
  fromDate: string;
  toDate: string;
  cfg?: MarketConfig;
  orgCachePath?: string;
  /** Line-item requests in flight at once. */
  concurrency?: number;
  onProgress?: (info: { listed: number; candidates: number; done: number }) => void;
}

type OrgCache = Record<string, string>;

function asList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const results = (body as { results?: unknown })?.results;
  return Array.isArray(results) ? (results as T[]) : [];
}

function egzCodes(items: ZakupDictItem[]): Map<number, number> {
  const codes = new Map<number, number>();
  for (const item of items) {
    const egz = Number(item.egz_code);
    if (item.egz_code && Number.isFinite(egz)) codes.set(item.id, egz);
  }
  return codes;
}

function loadOrgCache(filePath: string): OrgCache {
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveOrgCache(filePath: string, cache: OrgCache): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(cache), "utf8");
}

function allPrefixes(cfg: MarketConfig): string[] {
  return [...new Set([...cfg.groups["ИП"].prefixes, ...cfg.groups["КТ"].prefixes])];
}

/**
 * The platform imported some line items twice: same old id (`external_id`), a second apart.
 * ows had each item once, so keep the latest copy of every old id.
 */
export function dedupeSubjects<T extends { external_id?: number | string | null; timestamp?: number | null }>(subjects: T[]): T[] {
  const byOldId = new Map<string, T>();
  const withoutOldId: T[] = [];
  for (const s of subjects) {
    if (s.external_id === null || s.external_id === undefined || s.external_id === "") {
      withoutOldId.push(s);
      continue;
    }
    const key = String(s.external_id);
    const known = byOldId.get(key);
    if (!known || Number(s.timestamp ?? 0) >= Number(known.timestamp ?? 0)) byOldId.set(key, s);
  }
  return [...byOldId.values(), ...withoutOldId];
}

function subjectCode(s: ZakupSubject, contractCodes: string[]): string | null {
  return s.plan_item?.enstru?.code ?? (contractCodes.length === 1 ? contractCodes[0] : null);
}

/** Same item shape as the ows GraphQL source, so the filters and the cache stay one and the same. */
function toRawContract(
  c: ZakupContract,
  subjects: ZakupSubject[],
  statusEgz: number,
  methodEgz: Map<number, number>,
  orgs: OrgCache
): RawContractItem {
  const methodId = c.actual_purchase_method?.id ?? c.purchase_method_id ?? null;
  const contractCodes = c.enstru_code ?? [];
  const units: RawContractUnit[] = subjects.map((s) => {
    const code = subjectCode(s, contractCodes);
    const price = Number(s.item_price_without_vat ?? 0);
    const qty = Number(s.quantity ?? 0);
    return {
      refEnstruCode: code ?? undefined,
      quantity: qty,
      itemPrice: price,
      totalSum: s.contract_price_without_vat ?? s.purchase_total_price_without_vat ?? price * qty
    };
  });
  return {
    id: Number(c.external_id),
    signDate: c.sign_date ?? null,
    contractSum: c.contract_price_with_vat ?? null,
    faktTradeMethodsId: methodId != null ? methodEgz.get(methodId) ?? null : null,
    refContractStatusId: statusEgz,
    supplierBiin: orgs[String(c.supplier_organization_id)] ?? null,
    customerBin: orgs[String(c.customer_organization_id)] ?? null,
    Supplier: { nameRu: c.supplier_organization_name ?? null },
    Customer: { nameRu: c.customer_organization_name ?? null },
    ContractUnits: units
  };
}

/**
 * Market units (ИП, КТ) signed in [fromDate, toDate], from the public API of zakup.gov.kz.
 * Contracts are listed by ENSTRU prefix, plus goods contracts whose contract-level code list is empty
 * (the codes are then only in the line items). BINs are fetched only for contracts with a matching item.
 */
export async function fetchZakupMarketUnits(options: FetchZakupMarketOptions): Promise<MarketUnit[]> {
  const { fromDate, toDate, cfg = loadMarketConfig(), orgCachePath = DEFAULT_ORG_CACHE_PATH, concurrency = 4, onProgress } = options;
  const api: ZakupApiOptions = options;

  const statusEgz = egzCodes(asList<ZakupDictItem>(await zakupGet("/dicts/contract-statuses/", {}, api)));
  const methodEgz = egzCodes(asList<ZakupDictItem>(await zakupGet("/dicts/purchase-methods/", {}, api)));

  const period = { sign_date__gte: fromDate, sign_date__lte: toDate, system_id: GOSZAKUP_SYSTEM_ID };
  const byId = new Map<number, ZakupContract>();
  for (const prefix of allPrefixes(cfg)) {
    const rows = await zakupListAll<ZakupContract>("/public/contracts/", { ...period, enstru_code__startswith: prefix }, api);
    for (const row of rows) byId.set(row.id, row);
  }
  const withoutCodes = await zakupListAll<ZakupContract>(
    "/public/contracts/",
    { ...period, enstru_code__isnull: true, purchase_subject_id: GOODS_SUBJECT_ID },
    api
  );
  for (const row of withoutCodes) byId.set(row.id, row);

  const candidates = [...byId.values()].filter((c) => {
    if (!Number.isFinite(Number(c.external_id)) || c.external_id === null || c.external_id === "") return false;
    const egz = c.status_id != null ? statusEgz.get(c.status_id) : undefined;
    if (egz === undefined || isExcludedStatus(egz, cfg)) return false;
    const codes = c.enstru_code ?? [];
    return codes.length === 0 || codes.some((code) => classifyCode(code, cfg));
  });

  const orgs = loadOrgCache(orgCachePath);
  const knownOrgs = Object.keys(orgs).length;
  let done = 0;
  const raw = await mapWithConcurrency(candidates, concurrency, async (c): Promise<RawContractItem | null> => {
    const subjects = dedupeSubjects(asList<ZakupSubject>(await zakupGet(`/public/contracts/${c.id}/subjects/`, {}, api)));
    done++;
    if (onProgress && (done % 100 === 0 || done === candidates.length)) {
      onProgress({ listed: byId.size, candidates: candidates.length, done });
    }
    const contractCodes = c.enstru_code ?? [];
    const matches = subjects.some((s) => {
      const code = subjectCode(s, contractCodes);
      return code !== null && classifyCode(code, cfg) !== null;
    });
    if (!matches) return null;
    if (!orgs[String(c.supplier_organization_id)] || !orgs[String(c.customer_organization_id)]) {
      const detail = await zakupGet<ZakupContractDetail>(`/public/contracts/${c.id}/`, {}, api);
      for (const org of [detail?.supplier_organization, detail?.customer_organization]) {
        if (org?.id != null && org.iin_bin) orgs[String(org.id)] = String(org.iin_bin).trim();
      }
    }
    return toRawContract(c, subjects, statusEgz.get(c.status_id as number) as number, methodEgz, orgs);
  });

  if (Object.keys(orgs).length !== knownOrgs) saveOrgCache(orgCachePath, orgs);
  return filterContractUnits(raw.filter((item): item is RawContractItem => item !== null), cfg);
}
