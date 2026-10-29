import { goszakupGraphqlAll } from "./goszakupGraphql.js";
import { parseGoszakupPlanSearchHtml } from "./goszakupPlanHtmlParser.js";
import { GZ_PORTAL_ORIGIN } from "./goszakupOrigin.js";
import { mapWithConcurrency, zakupGet, zakupListAll } from "./zakupPublicApi.js";
import { withGzSourceFallback, type GzRegistryOptions } from "./zakupGzRegistry.js";

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

/**
 * Публичный поиск zakup не поддерживает rootrecordId. HTML-реестр определяет текущую версию,
 * а поля читаются из zakup. Отсутствующую там текущую версию нельзя заменять старой.
 */
async function currentPoint(root: number, options: GzRegistryOptions): Promise<{ id: number; status: string | null } | null> {
  const url = new URL(`${GZ_PORTAL_ORIGIN}/ru/registry/plan`);
  url.searchParams.set("filter[number]", String(root)); url.searchParams.set("count_record", "50");
  const response = await (options.fetchFn ?? fetch)(url.toString(), { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  if (!response.ok) throw new Error(`реестр планов: HTTP ${response.status}`);
  const html = await response.text();
  if (!/id=["']search-result["']/.test(html)) throw new Error("реестр планов: нет таблицы результатов (ограничение или технические работы)");
  const rows = parseGoszakupPlanSearchHtml(html, "zakup-root").filter(row => row.plan_list_number === String(root));
  const latest = rows.sort((a, b) => Number(b.plan_point_id) - Number(a.plan_point_id))[0];
  return latest ? { id: Number(latest.plan_point_id), status: latest.status } : null;
}

export async function fetchGzPlans(ids: readonly number[], by: "root" | "id", options: GzRegistryOptions = {}): Promise<ApiPlan[]> {
  const unique = [...new Set(ids)];
  if (unique.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Номер пункта должен быть положительным целым");
  const results = await mapWithConcurrency(unique, options.concurrency ?? 4, async (requested): Promise<ApiPlan[]> => withGzSourceFallback(async () => {
    const current = by === "root" ? await currentPoint(requested, options) : { id: requested, status: null };
    if (!current) return [];
    const listed = await zakupListAll<{ id: number; external_id: string | number }>("/public/plan-items/", { external_id: current.id, system_id: 1 }, options);
    const rows = listed.filter(row => Number(row.external_id) === current.id);
    if (!rows.length && by === "root") throw new Error(`zakup: текущая версия ${current.id} плана ${requested} отсутствует`);
    return mapWithConcurrency(rows, 1, async (row): Promise<ApiPlan> => {
      const detail = await zakupGet<PlanDetail>(`/public/plan-items/${row.id}/`, {}, options);
      if (Number(detail.external_id) !== current.id || !detail.status?.egz_code || !detail.status.name) throw new Error(`zakup: неверная карточка пункта ${current.id}`);
      if (current.status && current.status.trim() !== detail.status.name.trim()) throw new Error(`zakup: статус версии ${current.id} отстаёт от реестра (${detail.status.name} / ${current.status})`);
      const actDate = detail.plan?.act_date;
      return { id: Number(detail.external_id), rootrecordId: by === "root" ? requested : detail.root?.external_id ?? null,
        subjectBiin: detail.organization?.iin_bin ?? null,
        isActive: detail.is_externally_active === false || detail.is_externally_active === 0 ? 0 : 1,
        isDeleted: detail.is_externally_deleted ? 1 : 0,
        plnPointYear: detail.year?.year ?? null, refEnstruCode: detail.enstru?.code ?? null, nameRu: detail.name_ru ?? null,
        // timestamp — не доказанная дата создания версии. Берём консервативную дату утверждения акта.
        dateCreate: actDate && /^\d{4}-\d{2}-\d{2}$/.test(actDate) ? `${actDate} 00:00:00` : "",
        RefPlnPointStatus: { nameRu: detail.status.name } };
    });
  }, async () => goszakupGraphqlAll<ApiPlan>(`query($v:[Int],$after:Int){Plans(filter:{${by === "root" ? "rootrecordId" : "id"}:$v},limit:200,after:$after){id rootrecordId subjectBiin isActive isDeleted plnPointYear refEnstruCode nameRu dateCreate RefPlnPointStatus{nameRu}}}`, { v: [requested] }, "Plans", { ...options, token: options.token! }), options.token));
  return results.flat();
}
