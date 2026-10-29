import type { GzOutcomeContract } from "../bitrix/gzDealOutcome.js";
import { goszakupGraphqlAll } from "./goszakupGraphql.js";
import { mapWithConcurrency, zakupGet, zakupListAll } from "./zakupPublicApi.js";
import { fetchGzCustomerContracts, withGzSourceFallback, type GzRegistryOptions, type ZakupContractPlan } from "./zakupGzRegistry.js";

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


export interface GzPlanContext { bin: string; year: number }
export interface GzPlanLookupOptions extends GzRegistryOptions {
  contexts?: ReadonlyMap<number, GzPlanContext>;
  lookup?: GzPlanLookup;
}

/** Один экземпляр на прогон: договоры заказчика и карточки пунктов не читаются повторно. */
export class GzPlanLookup {
  private readonly contractsCache = new Map<string, Promise<GzOutcomeContract[]>>();
  private readonly contractPlans = new Map<string, Map<number, ZakupContractPlan>>();
  private readonly details = new Map<number, Promise<PlanDetail>>();
  constructor(private readonly options: GzRegistryOptions = {}) {}

  contracts(bin: string, years: number[]): Promise<GzOutcomeContract[]> {
    const key = bin + ':' + [...new Set(years)].sort().join(',');
    let pending = this.contractsCache.get(key);
    if (!pending) {
      const references = this.contractPlans.get(bin) ?? new Map<number, ZakupContractPlan>();
      this.contractPlans.set(bin, references);
      pending = fetchGzCustomerContracts(bin, years, { ...this.options, concurrency: 1, onPlanItem: item => {
        references.set(item.id, item); this.options.onPlanItem?.(item);
      }});
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
        await this.contracts(context.bin, context.year < currentYear ? [context.year, context.year + 1] : [context.year]);
        for (const ref of this.contractPlans.get(context.bin)?.values() ?? []) {
          if (Number(ref.root?.external_id) !== requested) continue;
          const d = await this.detail(ref.id);
          if (Number(d.external_id) === Number(ref.external_id) && accept(d)) candidates.push(d);
        }
      }
      const latest = candidates.sort((a,b) => Number(b.external_id) - Number(a.external_id))[0];
      if (!latest) return [];
      if (!latest.status?.egz_code || !latest.status.name) throw new Error(`zakup: неизвестный статус пункта ${requested}`);
      const actDate = latest.plan?.act_date;
      return [{ id: Number(latest.external_id), rootrecordId: by === 'root' ? requested : latest.root?.external_id ?? null,
        subjectBiin: latest.organization?.iin_bin ?? null, isActive: 1, isDeleted: 0,
        plnPointYear: latest.year?.year ?? null, refEnstruCode: latest.enstru?.code ?? null, nameRu: latest.name_ru ?? null,
        // timestamp не считаем датой версии. Дата акта — консервативная нижняя граница.
        dateCreate: actDate && /^\d{4}-\d{2}-\d{2}$/.test(actDate) ? actDate + ' 00:00:00' : '',
        RefPlnPointStatus: { nameRu: latest.status.name } }];
    }, async () => goszakupGraphqlAll<ApiPlan>(`query($v:[Int],$after:Int){Plans(filter:{${by === 'root' ? 'rootrecordId' : 'id'}:$v},limit:200,after:$after){id rootrecordId subjectBiin isActive isDeleted plnPointYear refEnstruCode nameRu dateCreate RefPlnPointStatus{nameRu}}}`, { v: [requested] }, 'Plans', { ...this.options, token: this.options.token! }), this.options.token));
    return rows.flat();
  }
}

export function fetchGzPlans(ids: readonly number[], by: 'root' | 'id', options: GzPlanLookupOptions = {}): Promise<ApiPlan[]> {
  return (options.lookup ?? new GzPlanLookup(options)).plans(ids, by, options.contexts);
}
