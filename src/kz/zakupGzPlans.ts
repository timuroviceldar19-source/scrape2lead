import type { GzOutcomeContract } from "../bitrix/gzDealOutcome.js";
import { goszakupGraphqlAll } from "./goszakupGraphql.js";
import { mapWithConcurrency, zakupGet, zakupListAll } from "./zakupPublicApi.js";
import { loadZakupCustomerContracts, mapZakupCustomerContracts, fetchOwsCustomerContracts, withGzSourceFallback, type GzRegistryOptions, type ZakupContractPlan, type ZakupCustomerContractData, type SubjectRow, type GzContractLookupPath, fullEnstruCodes } from "./zakupGzRegistry.js";

/** Формат прежнего GraphQL на границе источников. */
export interface ApiPlan {
  id: number;
  rootrecordId?: number | null;
  subjectBiin?: string | null;
  isActive?: number | null;
  isDeleted?: number | null;
  plnPointYear?: number | null;
  refEnstruCode?: string | null;
  nameRu?: string | null;
  dateCreate?: string | null;
  RefPlnPointStatus?: { nameRu?: string | null } | null;
}

interface PlanDetail {
  id: number; external_id: number;
  root?: { external_id?: number | null } | null;
  organization?: { iin_bin?: string | null } | null;
  enstru?: { code?: string | null } | null;
  status?: { name?: string | null; egz_code?: string | null } | null;
  name_ru?: string | null; year?: { year?: number | null } | null;
  is_externally_active?: boolean | number | null; is_externally_deleted?: boolean | number | null;
  plan?: { act_date?: string | null } | null;
}


export interface GzPlanContext { bin: string; year: number; codes?: readonly string[]; pointIds?: readonly number[] }
export interface GzPlanLookupOptions extends GzRegistryOptions {
  contexts?: ReadonlyMap<number, GzPlanContext>;
  lookup?: GzPlanLookup;
}

/** Один экземпляр на прогон: договоры заказчика и карточки пунктов не читаются повторно. */
export class GzPlanLookup {

  private readonly rawCache = new Map<string, Promise<ZakupCustomerContractData[]>>();
  private readonly fullResults = new Map<string, ZakupCustomerContractData[]>();
  private readonly contractsCache = new Map<string, Promise<GzOutcomeContract[]>>();
  private readonly contractPlans = new Map<string, Map<number, ZakupContractPlan>>();
  private readonly lotHeaders = new Map<string, Map<number, string>>();
  private readonly lotCache = new Map<string, Promise<void>>();
  private readonly details = new Map<number, Promise<PlanDetail>>();
  private readonly currentCodes = new WeakMap<GzPlanContext, Set<string>>();
  private readonly contractSources = new WeakMap<GzOutcomeContract, GzContractLookupPath>();
  readonly fullScanPlans = new Set<number>();
  readonly fullScanBins = new Set<string>();
  readonly planSources = new Map<number, 'q' | GzContractLookupPath>();
  constructor(private readonly options: GzPlanLookupOptions = {}) {}

  codesForContext(context: GzPlanContext | undefined): string[] {
    return context ? fullEnstruCodes(context.codes, [...(this.currentCodes.get(context) ?? [])]) : [];
  }
  sourceForContract(contract: GzOutcomeContract): GzContractLookupPath | null { return this.contractSources.get(contract) ?? null; }
  private baseKey(bin: string, years: number[]): string { return bin + ':' + [...new Set(years)].sort().join(','); }
  private remember(bin: string, item: ZakupContractPlan): void {
    const refs = this.contractPlans.get(bin) ?? new Map<number, ZakupContractPlan>();
    const old = refs.get(item.id);
    const rank = { enstru: 0, lots: 1, full: 2, ows: 3 };
    if (!old || rank[item.lookupPath ?? 'full'] < rank[old.lookupPath ?? 'full']) refs.set(item.id, item);
    this.contractPlans.set(bin, refs); this.options.onPlanItem?.(item);
  }

  private raw(bin: string, years: number[], codes?: readonly string[], numbers?: readonly string[], ids?: ReadonlySet<number>): Promise<ZakupCustomerContractData[]> {
    const base = this.baseKey(bin, years); const valid = fullEnstruCodes(codes).sort();
    if (valid.length && this.fullResults.has(base)) return Promise.resolve(this.fullResults.get(base)!);
    const key = base + '|' + (numbers?.length ? 'lots:' + [...numbers].sort().join(',') : valid.length ? valid.join(',') : '*');
    let pending = this.rawCache.get(key);
    if (!pending) {
      if (!valid.length && !numbers?.length) this.fullScanBins.add(bin);
      pending = loadZakupCustomerContracts(bin, years, { ...this.options, concurrency: 1, enstruCodes: valid,
        contractNumbers: numbers, contractIds: ids, onPlanItem: item => this.remember(bin, item) });
      if (!valid.length && !numbers?.length) pending = pending.then(rows => { this.fullResults.set(base, rows); return rows; });
      this.rawCache.set(key, pending);
    }
    return pending;
  }

  private lots(bin: string, root: number, context: GzPlanContext): Promise<void> {
    const points = [...new Set([...(context.pointIds ?? []), root])].filter(id => Number.isSafeInteger(id) && id > 0);
    const key = bin + ':' + root + ':' + points.join(',');
    let pending = this.lotCache.get(key);
    if (!pending) {
      pending = (async () => {
        const announcements = new Set<number>();
        for (const point of points) {
          const lots = await zakupListAll<{ announcement_id?: number; customers?: Array<{ bin?: string }> }>('/public/lots/', { plan_item_external_id: point, system_id: 1 }, this.options);
          for (const lot of lots) {
            if (lot.customers?.length && !lot.customers.some(customer => customer.bin === bin)) continue;
            if (lot.announcement_id) announcements.add(lot.announcement_id);
          }
        }
        for (const id of announcements) {
          const body = await zakupGet<SubjectRow[] | { results: SubjectRow[]; next?: string | null }>(`/public/announcements/${id}/contracts/`, {}, this.options);
          if (!Array.isArray(body) && (!Array.isArray(body?.results) || body.next)) throw new Error('zakup: неполные позиции договоров объявления');
          for (const subject of Array.isArray(body) ? body : body.results) {
            const plan = subject.plan_item;
            if (Number(plan?.root?.external_id) !== root || !plan?.id || !plan.external_id) continue;
            this.remember(bin, { id: plan.id, external_id: plan.external_id, root: plan.root, lookupPath: 'lots' });
            if (subject.contract?.id && subject.contract.contract_number_sys) {
              const headers = this.lotHeaders.get(bin) ?? new Map<number, string>();
              headers.set(subject.contract.id, subject.contract.contract_number_sys); this.lotHeaders.set(bin, headers);
            }
          }
        }
      })();
      this.lotCache.set(key, pending);
    }
    return pending;
  }

  contracts(bin: string, years: number[]): Promise<GzOutcomeContract[]> {
    const contexts = [...new Set(this.options.contexts?.values() ?? [])].filter(context => context.bin === bin);
    const codes = fullEnstruCodes(contexts.flatMap(context => this.codesForContext(context)));
    const full = !contexts.length || contexts.some(context => !this.codesForContext(context).length);
    const lotIds = this.lotHeaders.get(bin) ?? new Map<number, string>();
    const key = this.baseKey(bin, years) + '|' + codes.sort().join(',') + '|' + full + '|' + [...lotIds.keys()].sort().join(',');
    let pending = this.contractsCache.get(key);
    if (!pending) {
      pending = withGzSourceFallback(async () => {
        const unique = new Map<number, ZakupCustomerContractData>();
        if (codes.length) for (const row of await this.raw(bin, years, codes)) unique.set(row.contract.id, row);
        const missing = new Map([...lotIds].filter(([id]) => !unique.has(id)));
        if (missing.size) for (const row of await this.raw(bin, years, undefined, [...missing.values()], new Set(missing.keys()))) unique.set(row.contract.id, row);
        if (full) for (const row of await this.raw(bin, years)) if (!unique.has(row.contract.id)) unique.set(row.contract.id, row);
        const data = [...unique.values()];
        const mapped = await mapZakupCustomerContracts(data, { ...this.options, concurrency: 1 });
        mapped.forEach((row, i) => this.contractSources.set(row, data[i].lookupPath)); return mapped;
      }, async () => {
        const mapped = await fetchOwsCustomerContracts(bin, years, this.options);
        mapped.forEach(row => this.contractSources.set(row, 'ows')); return mapped;
      }, this.options.token);
      this.contractsCache.set(key, pending);
    }
    return pending;
  }

  private detail(id: number): Promise<PlanDetail> {
    let pending = this.details.get(id);
    if (!pending) {
      pending = zakupGet<PlanDetail>(`/public/plan-items/${id}/`, {}, this.options);
      this.details.set(id, pending);
    }
    return pending;
  }

  async plans(ids: readonly number[], by: 'root' | 'id', contexts: ReadonlyMap<number, GzPlanContext> = new Map()): Promise<ApiPlan[]> {
    const unique = [...new Set(ids)];
    if (unique.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Номер пункта должен быть положительным целым');
    const rows = await mapWithConcurrency(unique, this.options.concurrency ?? 4, async requested => withGzSourceFallback(async () => {
      const context = contexts.get(requested);
      if (!context || !/^\d{12}$/.test(context.bin) || !Number.isInteger(context.year) || context.year < 2000) throw new Error(`нет проверяемого БИН и года для пункта ${requested}`);
      const listed = await zakupListAll<{id: number; external_id: string | number}>('/public/plan-items/', { [by === 'root' ? 'q' : 'external_id']: requested, system_id: 1 }, this.options);
      const candidates: PlanDetail[] = [];
      const accept = (d: PlanDetail) => d.organization?.iin_bin === context.bin && Number(d.year?.year) >= context.year
        && d.is_externally_deleted !== true && d.is_externally_deleted !== 1 && d.is_externally_active !== false && d.is_externally_active !== 0;
      for (const row of listed) {
        if (by === 'id' && Number(row.external_id) !== requested) continue;
        const d = await this.detail(row.id);
        if (accept(d)) candidates.push(d);
      }
      if (!candidates.length && by === 'root') {
        const currentYear = Number(new Date().toLocaleString('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric' }));
        const years = context.year < currentYear ? [context.year, context.year + 1] : [context.year];
        const codes = this.codesForContext(context);
        let failure: unknown;
        if (codes.length) { try { await this.raw(context.bin, years, codes); } catch (error) { failure = error; } }
        const hasRoot = () => [...(this.contractPlans.get(context.bin)?.values() ?? [])].some(ref => Number(ref.root?.external_id) === requested);
        if (!hasRoot()) { try { await this.lots(context.bin, requested, context); } catch (error) { failure ??= error; } }
        if (!hasRoot() && !codes.length) { this.fullScanPlans.add(requested); await this.raw(context.bin, years); }
        if (!hasRoot() && failure) throw failure;
        for (const ref of this.contractPlans.get(context.bin)?.values() ?? []) {
          if (Number(ref.root?.external_id) !== requested) continue;
          const d = await this.detail(ref.id);
          if (Number(d.external_id) === Number(ref.external_id) && accept(d)) candidates.push(d);
        }
      }
      const latest = candidates.sort((a,b) => Number(b.external_id) - Number(a.external_id))[0];
      if (!latest) return [];
      if (!latest.status?.egz_code || !latest.status.name) throw new Error(`zakup: неизвестный статус пункта ${requested}`);
      const codes = this.currentCodes.get(context) ?? new Set<string>();
      for (const code of fullEnstruCodes(latest.enstru?.code)) codes.add(code);
      this.currentCodes.set(context, codes);
      if (by === 'root') this.planSources.set(requested, listed.some(row => row.id === latest.id) ? 'q' : this.contractPlans.get(context.bin)?.get(latest.id)?.lookupPath ?? 'enstru');
      const actDate = latest.plan?.act_date;
      return [{ id: Number(latest.external_id), rootrecordId: by === 'root' ? requested : latest.root?.external_id ?? null,
        subjectBiin: latest.organization?.iin_bin ?? null, isActive: 1, isDeleted: 0,
        plnPointYear: latest.year?.year ?? null, refEnstruCode: latest.enstru?.code ?? null, nameRu: latest.name_ru ?? null,
        // timestamp не считаем датой версии. Дата акта — консервативная нижняя граница.
        dateCreate: actDate && /^\d{4}-\d{2}-\d{2}$/.test(actDate) ? actDate + ' 00:00:00' : '',
        RefPlnPointStatus: { nameRu: latest.status.name } }];
    }, async () => {
      const plans = await goszakupGraphqlAll<ApiPlan>(`query($v:[Int],$after:Int){Plans(filter:{${by === 'root' ? 'rootrecordId' : 'id'}:$v},limit:200,after:$after){id rootrecordId subjectBiin isActive isDeleted plnPointYear refEnstruCode nameRu dateCreate RefPlnPointStatus{nameRu}}}`, { v: [requested] }, 'Plans', { ...this.options, token: this.options.token! });
      if (by === 'root' && plans.length) this.planSources.set(requested, 'ows');
      return plans;
    }, this.options.token));
    return rows.flat();
  }
}

export function fetchGzPlans(ids: readonly number[], by: 'root' | 'id', options: GzPlanLookupOptions = {}): Promise<ApiPlan[]> {
  return (options.lookup ?? new GzPlanLookup(options)).plans(ids, by, options.contexts);
}
