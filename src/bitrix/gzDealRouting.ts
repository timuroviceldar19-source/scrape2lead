import fs from "node:fs";
import { z } from "zod";

const routingRuleSchema = z.object({
  name: z.string().min(1),
  /** ЕНСТРУ-суффиксы (последние значащие цифры кода), например [21, 43]. */
  enstruSuffixes: z.array(z.number().int().nonnegative()).optional(),
  /** Подстроки для поиска в keyword/itemName без учёта регистра. */
  keywordsAny: z.array(z.string().min(1)).optional(),
  categoryId: z.number().int().nonnegative(),
  stageId: z.string().min(1),
  publishedStageId: z.string().min(1)
}).refine(
  (rule) => (rule.enstruSuffixes?.length ?? 0) > 0 || (rule.keywordsAny?.length ?? 0) > 0,
  { message: "routing rule needs enstruSuffixes and/or keywordsAny" }
);

export const gzRoutingConfigSchema = z.object({
  rules: z.array(routingRuleSchema).min(1),
  default: z.object({
    categoryId: z.number().int().nonnegative(),
    stageId: z.string().min(1),
    publishedStageId: z.string().min(1)
  })
}).superRefine((config, ctx) => {
  const mappings = new Map<number, { stageId: string; publishedStageId: string }>();
  for (const route of [...config.rules, config.default]) {
    const existing = mappings.get(route.categoryId);
    if (existing && (existing.stageId !== route.stageId || existing.publishedStageId !== route.publishedStageId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `conflicting stage mapping for category ${route.categoryId}`
      });
      continue;
    }
    mappings.set(route.categoryId, { stageId: route.stageId, publishedStageId: route.publishedStageId });
  }
});

export type GzRoutingConfig = z.infer<typeof gzRoutingConfigSchema>;
export type GzRoutingRule = z.infer<typeof routingRuleSchema>;

export interface GzRoutableRow {
  truCode?: string | null;
  keyword?: string | null;
  itemName?: string | null;
}

export interface GzRoute {
  categoryId: number;
  stageId: string;
  ruleName: string;
}

/**
 * Последние две значащие цифры последнего сегмента ЕНСТРУ-кода:
 * "262030.100.000043" -> 43, "262030.100.000021" -> 21. Null, если код пуст
 * или последний сегмент не числовой.
 */
export function extractEnstruSuffix(truCode: string | null | undefined): number | null {
  const lastSegment = (truCode ?? "").trim().split(".").pop() ?? "";
  if (!/^\d+$/.test(lastSegment)) return null;
  return Number.parseInt(lastSegment.slice(-2), 10);
}

export function resolveGzRoute(row: GzRoutableRow, config: GzRoutingConfig): GzRoute {
  const suffix = extractEnstruSuffix(row.truCode);
  const haystack = `${row.keyword ?? ""} ${row.itemName ?? ""}`.toLowerCase();

  for (const rule of config.rules) {
    const suffixMatch = rule.enstruSuffixes?.length
      ? suffix !== null && rule.enstruSuffixes.includes(suffix)
      : true;
    const keywordMatch = rule.keywordsAny?.length
      ? rule.keywordsAny.some((needle) => haystack.includes(needle.toLowerCase()))
      : true;
    if (suffixMatch && keywordMatch) {
      return { categoryId: rule.categoryId, stageId: rule.stageId, ruleName: rule.name };
    }
  }

  return {
    categoryId: config.default.categoryId,
    stageId: config.default.stageId,
    ruleName: "default"
  };
}

export function loadGzRoutingConfig(filePath: string): GzRoutingConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`gz routing config: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`gz routing config: invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return gzRoutingConfigSchema.parse(data);
}
