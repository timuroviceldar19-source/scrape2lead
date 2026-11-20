import fs from "node:fs";
import { z } from "zod";
import { EDUCATION_CODE } from "./educationImport.js";
import type { MarketEducationPending, MarketUnit } from "./types.js";

const verdictSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/).refine(id => Number.isSafeInteger(Number(id))),
  verdict: z.enum(["Да", "Нет"]),
  source: z.enum(["договор", "объявление"])
}).strict();

export type EducationVerdict = z.infer<typeof verdictSchema>;

/** Проверка строгая: ошибки файла не должны незаметно включать все комплекты. */
export function loadEducationVerdicts(filePath = "config/market-education-verdicts.json"): EducationVerdict[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Рынок: файл вердиктов учебных комплектов недоступен или содержит некорректный JSON");
  }
  const result = z.array(verdictSchema).safeParse(raw);
  if (!result.success) {
    // Не включаем содержимое ошибочной строки: там могут оказаться имена или суммы.
    throw new Error("Рынок: неверный формат вердиктов учебных комплектов (только id, verdict, source)");
  }
  const ids = new Set(result.data.map(row => row.id));
  if (ids.size !== result.data.length) {
    throw new Error("Рынок: повтор id в вердиктах учебных комплектов");
  }
  return result.data;
}

/** Фильтруются только позиции целевого кода, а не договор целиком. Кэш не меняется. */
export function applyEducationVerdicts(units: MarketUnit[], verdicts: EducationVerdict[]): {
  units: MarketUnit[];
  educationPending: MarketEducationPending;
  excludedContracts: number;
  pendingContracts: number;
} {
  const byId = new Map(verdicts.map(row => [row.id, row.verdict]));
  const excluded = new Set<number>();
  const pending = new Set<number>();
  const pendingMonths = new Map<string, { ids: Set<number>; sum: number }>();
  const kept = units.filter(unit => {
    if (unit.code !== EDUCATION_CODE) return true;
    const verdict = byId.get(String(unit.id));
    if (verdict === "Да") return true;
    if (verdict === "Нет") {
      excluded.add(unit.id);
    } else {
      pending.add(unit.id);
      const month = pendingMonths.get(unit.month) ?? { ids: new Set<number>(), sum: 0 };
      month.ids.add(unit.id);
      month.sum += unit.sum;
      pendingMonths.set(unit.month, month);
    }
    return false;
  });
  const educationPending = Object.fromEntries([...pendingMonths].sort(([a], [b]) => a.localeCompare(b)).map(([month, data]) => [month, {
    contracts: data.ids.size, sum: data.sum, ids: [...data.ids].sort((a, b) => a - b)
  }]));
  return { units: kept, educationPending, excludedContracts: excluded.size, pendingContracts: pending.size };
}
