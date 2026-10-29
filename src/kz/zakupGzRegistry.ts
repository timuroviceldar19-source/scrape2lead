import fs from "node:fs";
import path from "node:path";
import type { GzOutcomeContract } from "../bitrix/gzDealOutcome.js";
import { dedupeSubjects, DEFAULT_ORG_CACHE_PATH } from "./market/fetchZakupMarket.js";
import { mapWithConcurrency, zakupGet, zakupListAll, type ZakupApiOptions } from "./zakupPublicApi.js";
import { goszakupGraphqlAll } from "./goszakupGraphql.js";

export interface GzRegistryOptions extends ZakupApiOptions {
  token?: string | null;
  orgCachePath?: string;
  concurrency?: number;
}

/** Пустой успешный ответ не повод обращаться к резервному источнику. */
export async function withGzSourceFallback<T>(primary: () => Promise<T>, backup: () => Promise<T>, token?: string | null): Promise<T> {
  try { return await primary(); }
  catch (primaryError) {
    const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
    if (!token?.trim()) throw new Error(`zakup: ${message}; ows: токен не задан`);
    try { return await backup(); }
    catch (backupError) { throw new Error(`zakup: ${message}; ows: ${backupError instanceof Error ? backupError.message : String(backupError)}`); }
  }
}

interface DictRow { id: number; name?: string; egz_code?: string | null; year?: number }
interface Organization { id: number; iin_bin?: string | null }
interface ContractRow {
  id: number; external_id?: number; contract_number_sys?: string; sign_date?: string | null;
  status_id?: number; supplier_organization_id?: number; customer_organization_id?: number;
  supplier_organization_name?: string; is_externally_deleted?: boolean | number | null;
}
interface SubjectRow {
  external_id?: number | string | null; timestamp?: number | null; contract_price_without_vat?: number | null;
  plan_item?: { external_id?: number | null; root?: { external_id?: number | null } | null; name_ru?: string | null; enstru?: { code?: string | null } | null } | null;
  contract?: { supplier_organization?: Organization | null } | null;
}

/** Тот же файл id → БИН, что у рынка; обратный поиск выполняется по значениям. */
export class ZakupOrganizations {
  private cache: Record<string, string>;
  private readonly file: string;
  constructor(private readonly options: GzRegistryOptions) {
    this.file = options.orgCachePath ?? DEFAULT_ORG_CACHE_PATH;
    try { this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.cache = {}; }
  }
  remember(org: Organization | null | undefined): void {
    if (org?.id && /^\d{12}$/.test(org.iin_bin ?? "")) this.cache[String(org.id)] = org.iin_bin!;
  }
  async idForBin(bin: string): Promise<number> {
    if (!/^\d{12}$/.test(bin)) throw new Error("БИН должен содержать 12 цифр");
    const known = Object.entries(this.cache).find(([, value]) => value === bin);
    if (known) return Number(known[0]);
    const rows = await zakupListAll<Organization>("/public/organizations/", { q: bin }, this.options);
    const match = rows.find(row => row.iin_bin === bin);
    if (!match) throw new Error(`zakup: организация по БИН ${bin} не найдена`);
    this.remember(match); this.save(); return match.id;
  }
  async binForId(id: number): Promise<string> {
    const known = this.cache[String(id)];
    if (known) return known;
    const org = await zakupGet<Organization>(`/public/organizations/${id}/`, {}, this.options);
    this.remember(org);
    if (!this.cache[String(id)]) throw new Error(`zakup: организация ${id} без БИН`);
    this.save(); return this.cache[String(id)];
  }
  save(): void {
    if (!this.file) return;
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { /* Новый кэш. */ }
    const resolved = path.resolve(this.file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify({ ...disk, ...this.cache }), "utf8");
  }
}

const CONTRACTS_QUERY = `query($bin:String,$year:Int,$after:Int){Contract(filter:{customerBin:$bin,finYear:$year},limit:200,after:$after){
  contractNumberSys signDate supplierBiin deleted Supplier{nameRu} RefContractStatus{nameRu}
  ContractUnits{plnPointId totalSum refEnstruCode Plans{rootrecordId nameRu}}}}`;

export async function fetchGzCustomerContracts(bin: string, years: number[], options: GzRegistryOptions = {}): Promise<GzOutcomeContract[]> {
  return withGzSourceFallback(async () => {
    const orgs = new ZakupOrganizations(options);
    const customerId = await orgs.idForBin(bin);
    const yearDict = await zakupGet<DictRow[]>("/dicts/years/", {}, options);
    const statuses = await zakupGet<DictRow[]>("/dicts/contract-statuses/", {}, options);
    if (!Array.isArray(yearDict) || !Array.isArray(statuses)) throw new Error("zakup: неверный справочник");
    const byId = new Map<number, ContractRow>();
    for (const year of new Set(years)) {
      const yearId = yearDict.find(row => row.year === year)?.id;
      if (!yearId) throw new Error(`zakup: год ${year} не найден в справочнике`);
      for (const row of await zakupListAll<ContractRow>("/public/contracts/", { customer_organization_id: customerId, year_id: yearId, system_id: 1 }, options)) byId.set(row.id, row);
    }
    const result = await mapWithConcurrency([...byId.values()], options.concurrency ?? 4, async (row): Promise<GzOutcomeContract> => {
      const status = statuses.find(s => s.id === row.status_id);
      if (!status?.egz_code || !status.name) throw new Error(`zakup: неизвестный статус договора ${row.status_id}`);
      const body = await zakupGet<SubjectRow[] | { results: SubjectRow[]; next?: string | null }>(`/public/contracts/${row.id}/subjects/`, {}, options);
      if (!Array.isArray(body) && (!Array.isArray(body?.results) || body.next)) throw new Error("zakup: неполные позиции договора");
      const subjects = dedupeSubjects(Array.isArray(body) ? body : body.results);
      for (const subject of subjects) orgs.remember(subject.contract?.supplier_organization);
      if (!row.supplier_organization_id) throw new Error("zakup: договор без поставщика");
      const supplierBin = await orgs.binForId(row.supplier_organization_id);
      if (!row.contract_number_sys) throw new Error("zakup: договор без системного номера");
      return {
        contractNumberSys: row.contract_number_sys, signDate: row.sign_date ?? null,
        supplierBiin: supplierBin, Supplier: { nameRu: row.supplier_organization_name ?? null },
        RefContractStatus: { nameRu: status.name }, deleted: row.is_externally_deleted ? 1 : 0,
        ContractUnits: subjects.map(s => ({ plnPointId: s.plan_item?.external_id ?? null,
          totalSum: s.contract_price_without_vat ?? null, refEnstruCode: s.plan_item?.enstru?.code ?? null,
          Plans: { rootrecordId: s.plan_item?.root?.external_id ?? null, nameRu: s.plan_item?.name_ru ?? null } }))
      };
    });
    orgs.save(); return result;
  }, async () => {
    const rows: GzOutcomeContract[] = [];
    for (const year of new Set(years)) rows.push(...await goszakupGraphqlAll<GzOutcomeContract>(CONTRACTS_QUERY, { bin, year }, "Contract", { ...options, token: options.token! }));
    return rows;
  }, options.token);
}
