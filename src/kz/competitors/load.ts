import fs from "node:fs";
import path from "node:path";
import { buildCompetitorsView } from "./aggregate.js";
import { collectCompetitors, type CollectCompetitorsOptions } from "./collector.js";
import { loadCompetitorsConfig } from "./config.js";
import { CompetitorsStorage, DEFAULT_COMPETITORS_DB_PATH } from "./storage.js";
import type { CompetitorsConfig, CompetitorsView } from "./types.js";

/**
 * Лимит полного сбора (`--competitors-backfill-from`) в минутах. Задача GitHub с полным сбором живёт 240 минут,
 * и при таймауте кэш не сохраняется вовсе. Поэтому сбор останавливается сам раньше: собранное остаётся в базе,
 * пульт успевает собраться, кэш сохраняется, а следующий запуск продолжает с того же места.
 * Другое значение — `--competitors-budget-min N`.
 */
export const DEFAULT_BACKFILL_BUDGET_MIN = 200;

export function resolveBackfillBudgetMs(args: readonly string[]): number {
  const idx = args.indexOf("--competitors-budget-min");
  const minutes = idx !== -1 ? Number(args[idx + 1]) : NaN;
  const value = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_BACKFILL_BUDGET_MIN;
  return value * 60 * 1000;
}

export interface UpdateCompetitorsWindowOptions extends Omit<CollectCompetitorsOptions, "fromDate" | "toDate" | "incremental"> {
  todayAlmaty: string;
  strict?: boolean;
  windowDays?: number;
}

/**
 * Daily incremental refresh: discovers recent lots (last 45 days) plus refreshes any
 * previously non-terminal lots. Preserves yesterday's cache on failure in non-strict mode.
 */
export async function updateCompetitorsWindow(options: UpdateCompetitorsWindowOptions): Promise<number | undefined> {
  const { todayAlmaty, windowDays = 45, dbPath = DEFAULT_COMPETITORS_DB_PATH } = options;
  const maxDurationMs = options.maxDurationMs ?? 20 * 60 * 1000;
  const d = new Date(Date.parse(`${todayAlmaty}T12:00:00Z`));
  d.setUTCDate(d.getUTCDate() - windowDays);
  const cutoffDate = d.toISOString().slice(0, 10);

  try {
    console.log(`[Конкуренты] Утреннее обновление за последние ${windowDays} дней (с ${cutoffDate})...`);
    const res = await collectCompetitors({
      ...options,
      fromDate: cutoffDate,
      toDate: todayAlmaty,
      dbPath,
      incremental: true,
      maxDurationMs
    });
    if (res.incomplete) {
      const msg = `[Конкуренты] Сбор неполный: осталось ${res.remainingMissingDetails} карточек (${res.stopReason || "лимит времени/ошибки"}), используем актуальный кэш`;
      if (options.strict) throw new Error(msg);
      console.warn(`::warning::${msg}`);
    } else {
      console.log(
        `[Конкуренты] Обновлено: лотов ${res.lotsCount}, заявок ${res.bidsCount}, ТС ${res.specsCount}, объявлений обновлено ${res.refreshedAnnos}, ошибок ${res.errors.length}`
      );
    }
    return res.lotsCount;
  } catch (err) {
    if (options.strict) throw err;
    console.warn(`::warning::[Конкуренты] Ошибка при утреннем обновлении (используем вчерашний кэш): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export interface LoadCompetitorsOptions {
  todayAlmaty: string;
  dbPath?: string;
  cfg?: CompetitorsConfig;
}

export function loadCompetitorsView(options: LoadCompetitorsOptions): CompetitorsView {
  const { todayAlmaty, dbPath = DEFAULT_COMPETITORS_DB_PATH, cfg = loadCompetitorsConfig() } = options;
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    console.log(`[Конкуренты] Кэш ${dbPath} не найден`);
    return {
      asOf: todayAlmaty,
      months: [],
      ip: null,
      kt: null,
      error: "Данные конкурентов ещё собираются."
    };
  }

  const storage = new CompetitorsStorage(resolved);
  try {
    const lots = storage.loadLots(true);
    const bids = storage.loadBids(true);
    const templateMatches = storage.loadTemplateMatches();
    const updatedAt = storage.getMeta("updated_at") ?? undefined;
    if (lots.length === 0) {
      return {
        asOf: todayAlmaty,
        updatedAt,
        months: [],
        ip: null,
        kt: null,
        error: "Данные конкурентов ещё собираются."
      };
    }
    return buildCompetitorsView({
      lots,
      bids,
      templateMatches,
      asOfDate: todayAlmaty,
      updatedAt,
      cfg
    });
  } finally {
    storage.close();
  }
}
