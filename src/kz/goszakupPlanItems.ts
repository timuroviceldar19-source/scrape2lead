import { goszakupGraphqlAll, type GoszakupGraphqlOptions } from "./goszakupGraphql.js";
import { fetchGzPlans, GzPlanLookup, type GzPlanLookupOptions } from "./zakupGzPlans.js";
import { mapWithConcurrency } from "./zakupPublicApi.js";

/** Действующая версия пункта плана под номером, который показывает портал. */
export interface CurrentPlanItem {
  /** Внутренний номер версии: после правки заказчиком он новый. */
  id: number;
  /** Номер пункта на портале (`rootrecordId`), он не меняется. */
  rootId: number;
  code: string;
  name: string;
  /** БИН заказчика; по нему отсеиваются записи, которые только совпали по номеру. */
  bin: string | null;
  year: number | null;
  /** Когда создана эта версия, время Алматы, `YYYY-MM-DD HH:mm:ss`. */
  createdAt: string;
}

interface PlanRow {
  id?: number;
  rootrecordId?: number | null;
  subjectBiin?: string | null;
  isActive?: number | null;
  isDeleted?: number | null;
  plnPointYear?: number | null;
  dateCreate?: string | null;
  refEnstruCode?: string | null;
  nameRu?: string | null;
}

const BATCH = 100;
const PLANS_BY_ROOT = `query($v: [Int], $after: Int) {
  Plans(filter: { rootrecordId: $v }, limit: 200, after: $after) {
    id rootrecordId subjectBiin isActive isDeleted plnPointYear dateCreate refEnstruCode nameRu
  }
}`;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Текущий код и название товара по пунктам плана. Заказчик правит пункт: номер на портале тот же, запись в реестре новая,
 * старая исчезает или помечается неактивной. Берём действующую версию с наибольшим номером.
 * Номера, которых реестр не знает, в результат не попадают; номера пачки, которую не удалось прочитать, идут в `failed`.
 */
export async function fetchCurrentPlanItems(
  roots: number[],
  options: GzPlanLookupOptions
): Promise<{ items: Map<number, CurrentPlanItem>; failed: number[] }> {
  // Сохраняем пакетный резерв для старых потребителей, ещё не передающих контекст сделки.
  if (!options.contexts && !options.lookup && options.token) return fetchCurrentPlanItemsOws(roots, { ...options, token: options.token });
  const lookup = options.lookup ?? new GzPlanLookup(options);
  const items = new Map<number, CurrentPlanItem>();
  const failed: number[] = [];
  await mapWithConcurrency([...new Set(roots.filter(root => Number.isSafeInteger(root) && root > 0))], options.concurrency ?? 4, async root => {
    try {
      const rows = await fetchGzPlans([root], "root", { ...options, lookup });
      for (const row of rows) {
        if (row.isActive === 0 || row.isDeleted) continue;
        // Дату синхронизации нельзя выдавать за дату версии и разрешать по ней правку старого товара.
        if (!row.dateCreate) { failed.push(root); continue; }
        items.set(root, { id: row.id, rootId: root, code: text(row.refEnstruCode), name: text(row.nameRu),
          bin: row.subjectBiin ?? null, year: row.plnPointYear ?? null, createdAt: row.dateCreate });
      }
    } catch { failed.push(root); }
  });
  return { items, failed };
}

async function fetchCurrentPlanItemsOws(
  roots: number[],
  options: GoszakupGraphqlOptions
): Promise<{ items: Map<number, CurrentPlanItem>; failed: number[] }> {
  const items = new Map<number, CurrentPlanItem>();
  const failed: number[] = [];
  const unique = [...new Set(roots.filter((root) => Number.isInteger(root) && root > 0))];

  for (let start = 0; start < unique.length; start += BATCH) {
    const batch = unique.slice(start, start + BATCH);
    let rows: PlanRow[];
    try {
      rows = await goszakupGraphqlAll<PlanRow>(PLANS_BY_ROOT, { v: batch }, "Plans", options);
    } catch {
      failed.push(...batch);
      continue;
    }
    for (const row of rows) {
      if (Number(row.isActive) === 0 || Number(row.isDeleted) === 1 || !Number.isInteger(row.id)) continue;
      const rootId = Number(row.rootrecordId ?? row.id);
      const known = items.get(rootId);
      if (known && known.id > Number(row.id)) continue;
      const bin = text(row.subjectBiin);
      items.set(rootId, {
        id: Number(row.id),
        rootId,
        code: text(row.refEnstruCode),
        name: text(row.nameRu),
        bin: /^\d{12}$/.test(bin) ? bin : null,
        year: typeof row.plnPointYear === "number" ? row.plnPointYear : null,
        createdAt: text(row.dateCreate)
      });
    }
  }
  return { items, failed };
}
