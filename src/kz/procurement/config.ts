import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  sources: z.array(z.enum(["mitwork", "samruk", "tizilim"])).min(1),
  keywords: z.array(z.string().trim().min(1)).min(1),
  minAmount: z.number().nonnegative(),
  pkTruPrefixes: z.array(z.string().trim().min(1)).min(1),
  panelKeywords: z.array(z.string().trim().min(1)).min(1),
  stopWords: z.array(z.string().trim().min(1)),
  /** Ширина скользящего окна в месяцах: «текущий месяц плюс следующие шесть» — это 7. */
  rollingMonths: z.number().int().min(1).max(24).default(7),
  /** Подсказки `год -> plan_year_id`. Проверяются пробой источника, а не принимаются на веру. */
  planYearIds: z.record(z.string().regex(/^\d{4}$/), z.number().int().min(1)).default({}),
  planYearProbeRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 32]),
  planStatuses: z.array(z.object({
    name: z.string().trim().min(1),
    /** null — статус заявлен, но его id в источнике неизвестен: даёт warning, не блокирует сбор. */
    id: z.number().int().min(1).nullable()
  })).min(1).default([{ name: "Утвержден", id: 2 }]),
  pageSize: z.number().int().min(1).max(100).default(100),
  maxPages: z.number().int().min(1).default(500),
  delayMs: z.number().int().nonnegative().default(200),
  detailConcurrency: z.number().int().min(1).max(20).default(6),
  databasePath: z.string().min(1),
  /** null отключает обогащение из локальной БД GZ — так результат CI не зависит от её наличия. */
  goszakupRegistryDatabasePath: z.string().min(1).nullable().default("data/scrape2lead.db"),
  outputDirectory: z.string().min(1),
  manualRunsRequired: z.number().int().min(1).default(7),
  bitrix: z.object({
    categoryId: z.literal(1),
    stageId: z.literal("C1:NEW"),
    managerIds: z.tuple([z.literal("2255")]),
    executeEnabled: z.boolean().default(false)
  })
});

export type ProcurementConfig = z.infer<typeof schema>;

export function loadProcurementConfig(configPath: string): ProcurementConfig {
  const resolved = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  return schema.parse(parsed);
}
