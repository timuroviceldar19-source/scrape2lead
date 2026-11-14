import fs from "node:fs";
import { z } from "zod";

/**
 * Правила по количеству для новых сделок GZ (планы и лоты).
 *
 * Отдел продаж (13.11.2026): ПК, моноблоки и ноутбуки — только от 3 шт; мониторы не заводим;
 * МФУ и принтеры — только больше 10 шт; интерактивные панели — как раньше, без порога.
 * Крупные закупки (сумма от `keepFromAmount`, сейчас 2 млн ₸) заводятся при любом количестве (14.11.2026).
 *
 * Правило проверяется только перед созданием сделки. Уже заведённые карточки обновляются как раньше.
 * Позиция относится к первому правилу, у которого совпал префикс кода ЕНС ТРУ или шаблон названия.
 * Если правило не нашлось или количество не прочиталось, сделка заводится (лучше лишняя карточка,
 * чем потерянная закупка).
 */
const quantityRuleSchema = z.object({
  name: z.string().min(1),
  /** Префиксы кода ЕНС ТРУ, например "262017.100.". */
  truCodePrefixes: z.array(z.string().min(1)).default([]),
  /** Регулярные выражения по названию позиции, без учёта регистра. */
  namePatterns: z.array(z.string().min(1)).default([]),
  /** true — не заводить такие сделки совсем. */
  exclude: z.boolean().default(false),
  /** Наименьшее количество, при котором сделка заводится. */
  minQuantity: z.number().positive().optional(),
  /** Сумма закупки (₸), от которой сделка заводится при любом количестве. Работает только вместе с minQuantity. */
  keepFromAmount: z.number().positive().optional()
}).refine(
  (rule) => rule.truCodePrefixes.length > 0 || rule.namePatterns.length > 0,
  { message: "quantity rule needs truCodePrefixes and/or namePatterns" }
).refine(
  (rule) => rule.keepFromAmount === undefined || rule.minQuantity !== undefined,
  { message: "keepFromAmount works only together with minQuantity" }
).superRefine((rule, ctx) => {
  for (const pattern of rule.namePatterns) {
    try {
      new RegExp(pattern, "iu");
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rule ${rule.name}: invalid name pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
});

export const gzQuantityRulesSchema = z.object({
  rules: z.array(quantityRuleSchema).min(1)
});

export type GzQuantityRulesConfig = z.infer<typeof gzQuantityRulesSchema>;
export type GzQuantityRule = GzQuantityRulesConfig["rules"][number];

export const DEFAULT_GZ_QUANTITY_RULES_PATH = "config/gz-quantity-rules.json";

export interface GzQuantityItem {
  truCode?: string | null;
  name?: string | null;
  quantity?: string | number | null;
  /** Сумма плана или лота, ₸. */
  amount?: string | number | null;
}

export interface GzQuantityDecision {
  allowed: boolean;
  ruleName: string | null;
  quantity: number | null;
  /** Количество ниже порога, но сделка заводится из-за суммы (keepFromAmount). */
  keptByAmount: boolean;
  /** Почему сделка не заводится; null, если заводится. */
  reason: string | null;
  /** Правило требует количество, но его не удалось прочитать. Сделка заводится. */
  warning: string | null;
}

export function loadGzQuantityRules(filePath = DEFAULT_GZ_QUANTITY_RULES_PATH): GzQuantityRulesConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`gz quantity rules: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`gz quantity rules: invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return gzQuantityRulesSchema.parse(data);
}

export function classifyGzItem(item: GzQuantityItem, config: GzQuantityRulesConfig): GzQuantityRule | null {
  const code = (item.truCode ?? "").trim();
  const name = (item.name ?? "").normalize("NFKC").replace(/ё/gi, "е").trim();
  return config.rules.find((rule) =>
    (code !== "" && rule.truCodePrefixes.some((prefix) => code.startsWith(prefix)))
    || (name !== "" && rule.namePatterns.some((pattern) => new RegExp(pattern, "iu").test(name)))
  ) ?? null;
}

export function checkGzQuantityRules(item: GzQuantityItem, config: GzQuantityRulesConfig): GzQuantityDecision {
  const rule = classifyGzItem(item, config);
  const quantity = parseGzQuantity(item.quantity);
  const decision = (allowed: boolean, reason: string | null = null, warning: string | null = null, keptByAmount = false): GzQuantityDecision =>
    ({ allowed, ruleName: rule?.name ?? null, quantity, keptByAmount, reason, warning });

  if (!rule) return decision(true);
  if (rule.exclude) return decision(false, `${rule.name}: такие позиции не заводим`);
  if (rule.minQuantity === undefined) return decision(true);
  // Ноль на портале значит «не указано» (в истории есть «Компьютер», 0 шт на 500 млн), а не заказ на ноль штук.
  if (quantity === null || quantity <= 0) {
    return decision(true, null, `${rule.name}: количество не прочитано (${String(item.quantity ?? "").trim() || "пусто"}), сделка заводится`);
  }
  if (quantity >= rule.minQuantity) return decision(true);
  const amount = parseGzAmount(item.amount);
  if (rule.keepFromAmount !== undefined && amount !== null && amount >= rule.keepFromAmount) {
    return decision(true, null, null, true);
  }
  const amountNote = rule.keepFromAmount === undefined ? "" : ` или сумма от ${formatTenge(rule.keepFromAmount)} ₸`;
  return decision(false, `${rule.name}: количество ${quantity}, нужно не меньше ${rule.minQuantity}${amountNote}`);
}

/** "4 482 758.60" -> 4482758.6, "900000,5" -> 900000.5; пусто или не число -> null. */
export function parseGzAmount(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const compact = String(value ?? "").replace(/[\s  ]+/g, "").replace(",", ".");
  if (!compact) return null;
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTenge(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value).replace(/[  ]/g, " ");
}

/** "4" -> 4, "1 200" -> 1200, "2,000" -> 2, "20 шт" -> 20; пусто или без числа -> null. */
export function parseGzQuantity(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const compact = String(value ?? "").replace(/(\d)[\s  ]+(?=\d)/g, "$1").trim();
  const match = /^\d+(?:[.,]\d+)?/.exec(compact);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}
