import fs from "node:fs";
import path from "node:path";
import { mapWithConcurrency, zakupGet, zakupListAll, zakupErrorReason, zakupSafeCause, ZakupIncompleteDataError, type ZakupApiOptions } from "../zakupPublicApi.js";
import { classifyCode, isExcludedStatus, loadMarketConfig } from "./config.js";
import { filterContractUnits, type RawContractItem, type RawContractUnit } from "./filterUnits.js";
import type { MarketConfig, MarketUnit } from "./types.js";

/** БИН организаций по их id на платформе: в списке договоров есть только id, а за БИН нужен отдельный запрос. */
export const DEFAULT_ORG_CACHE_PATH = "data/market/orgs.json";

/** Старый портал (ЭГЗ). Кэш рынка собран по нему, другие системы платформы в него не входят. */
const GOSZAKUP_SYSTEM_ID = 1;
/** «Товар» в справочнике предметов закупки. */
const GOODS_SUBJECT_ID = 1;
/** Массовый отказ основного API: прекращаем очередь и разрешаем запасной источник. */
export const MARKET_FIRST_PASS_FAILURE_LIMIT = 20;

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
  plan_item?: {
    enstru?: { code?: string | null } | null;
    name_ru?: string | null;
    extra_description_ru?: string | null;
    extra_description_kk?: string | null;
  } | null;
}

interface ZakupContractDetail {
  external_id?: number | string | null;
  supplier_organization?: { id?: number | null; iin_bin?: string | null } | null;
  customer_organization?: { id?: number | null; iin_bin?: string | null } | null;
}

export interface ZakupMarketStats {
  missingListIds: number;
  withoutCodes: number;
  skippedWithoutId: number;
}

export interface ZakupMarketResult {
  units: MarketUnit[];
  keepContractIds: number[];
  stats: ZakupMarketStats;
}

function contractId(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || String(value).trim() === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface FetchZakupMarketOptions extends ZakupApiOptions {
  fromDate: string;
  toDate: string;
  cfg?: MarketConfig;
  orgCachePath?: string;
  /** Line-item requests in flight at once. */
  concurrency?: number;
  /** Пауза перед вторым проходом по неответившим договорам. */
  secondPassDelayMs?: number;
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
    const pi = s.plan_item;
    const text = [pi?.name_ru, pi?.extra_description_ru, pi?.extra_description_kk]
      .filter((v): v is string => Boolean(v && typeof v === "string" && v.trim()))
      .join(" ");
    return {
      refEnstruCode: code ?? undefined,
      quantity: qty,
      itemPrice: price,
      totalSum: s.contract_price_without_vat ?? s.purchase_total_price_without_vat ?? price * qty,
      text
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
 * (the codes are then only in the line items). Cards supply missing numbers and BINs;
 * uncoded contracts may retain existing units, but never manufacture new market positions.
 */
export async function fetchZakupMarketUnits(options: FetchZakupMarketOptions): Promise<ZakupMarketResult> {
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
    const egz = c.status_id != null ? statusEgz.get(c.status_id) : undefined;
    // Список уже ограничен префиксами. Его коды могут отличаться от предметов:
    // ранний фильтр по точному коду скрыл бы договоры с неизвестными кодами предметов.
    return egz !== undefined && !isExcludedStatus(egz, cfg);
  });

  const orgs = loadOrgCache(orgCachePath);
  const knownOrgs = Object.keys(orgs).length;
  const stats: ZakupMarketStats = {
    missingListIds: candidates.filter(c => contractId(c.external_id) === null).length,
    withoutCodes: 0,
    skippedWithoutId: 0
  };
  const keepContractIds = new Set<number>();
  const readContract = async (c: ZakupContract): Promise<RawContractItem | null> => {
    const subjects = dedupeSubjects(asList<ZakupSubject>(await zakupGet(`/public/contracts/${c.id}/subjects/`, {}, api)));
    const contractCodes = c.enstru_code ?? [];
    const matches = subjects.some((s) => {
      const code = subjectCode(s, contractCodes);
      const pi = s.plan_item;
      const text = [pi?.name_ru, pi?.extra_description_ru, pi?.extra_description_kk]
        .filter((v): v is string => Boolean(v && typeof v === "string" && v.trim()))
        .join(" ");
      return code !== null && classifyCode(code, cfg, text) !== null;
    });
    const withoutCode = !matches && (subjects.length === 0 || subjects.some(s => subjectCode(s, contractCodes) === null));
    if (!matches && !withoutCode) return null;
    let id = contractId(c.external_id);
    // Один запрос карточки и для номера, и для БИН. Ошибки не превращаются в пропуск договора.
    if (id === null || (matches && (!orgs[String(c.supplier_organization_id)] || !orgs[String(c.customer_organization_id)]))) {
      const detail = await zakupGet<ZakupContractDetail>(`/public/contracts/${c.id}/`, {}, api);
      id ??= contractId(detail?.external_id);
      for (const org of [detail?.supplier_organization, detail?.customer_organization]) {
        if (org?.id != null && org.iin_bin) orgs[String(org.id)] = String(org.iin_bin).trim();
      }
    }
    // Счётчики меняются только после успешного чтения всех необходимых данных.
    if (withoutCode) stats.withoutCodes++;
    if (id === null) {
      stats.skippedWithoutId++;
      return null;
    }
    if (withoutCode) {
      keepContractIds.add(id);
      return null;
    }
    return toRawContract({ ...c, external_id: id }, subjects, statusEgz.get(c.status_id as number) as number, methodEgz, orgs);
  };

  const raw: Array<RawContractItem | null> = Array(candidates.length).fill(null);
  const failed: Array<{ contract: ZakupContract; index: number; error: unknown }> = [];
  let done = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, candidates.length)) }, async () => {
    while (next < candidates.length && failed.length < MARKET_FIRST_PASS_FAILURE_LIMIT) {
      const index = next++;
      const contract = candidates[index];
      try {
        raw[index] = await readContract(contract);
      } catch (error) {
        failed.push({ contract, index, error });
      } finally {
        done++;
        if (onProgress && (done % 100 === 0 || done === candidates.length)) {
          onProgress({ listed: byId.size, candidates: candidates.length, done });
        }
      }
    }
  }));
  if (failed.length >= MARKET_FIRST_PASS_FAILURE_LIMIT) {
    const reasons = [...new Set(failed.map(item => zakupErrorReason(item.error)))].join("; ");
    // Обычная ошибка включает ows; все уже начатые чтения завершены, второй проход не запускается.
    throw new Error(`Рынок: массовый сбой чтения договоров: ${failed.length}; причины: ${reasons}`, {
      cause: zakupSafeCause(failed[0].error)
    });
  }
  if (failed.length) {
    const reasons = [...new Set(failed.map(item => zakupErrorReason(item.error)))].join("; ");
    console.warn(`[Рынок] Второй проход: договоров ${failed.length}; причины: ${reasons}`);
    const delay = options.secondPassDelayMs ?? 5000;
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const errors: unknown[] = [];
    await mapWithConcurrency(failed, concurrency, async ({ contract, index }) => {
      try {
        raw[index] = await readContract(contract);
      } catch (error) {
        errors.push(error);
      }
    });
    if (errors.length) {
      const finalReasons = [...new Set(errors.map(zakupErrorReason))].join("; ");
      throw new ZakupIncompleteDataError(`Рынок: договоров без ответа на обоих проходах: ${errors.length}; причины: ${finalReasons}`, { cause: zakupSafeCause(errors[0]) });
    }
  }

  if (Object.keys(orgs).length !== knownOrgs) saveOrgCache(orgCachePath, orgs);
  return { units: filterContractUnits(raw.filter((item): item is RawContractItem => item !== null), cfg), keepContractIds: [...keepContractIds].sort((a, b) => a - b), stats };
}
