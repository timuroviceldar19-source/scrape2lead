import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SalesPultPayload } from "./types.js";

export function getPultMonths(date: string) {
  const [year, month] = date.split("-").map(Number);
  return [0, 1, 2].map((offset) => {
    const from = new Date(Date.UTC(year, month - 1 - offset, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(year, month - offset, 0)).toISOString().slice(0, 10);
    return { key: from.slice(0, 7), from, to };
  });
}

/** Кэш содержит только готовые месяцы; ошибки не превращаются в нулевые итоги. */
export async function loadClosedMonths(
  today: string, directory: string, configIdentity: string,
  collect: (month: ReturnType<typeof getPultMonths>[number]) => Promise<SalesPultPayload>
): Promise<Record<string, SalesPultPayload | null>> {
  const signature = createHash("sha256").update(configIdentity).digest("hex");
  const result: Record<string, SalesPultPayload | null> = {};
  for (const month of getPultMonths(today).slice(1)) {
    const file = path.join(directory, `${month.key}.json`);
    try {
      let cached: { day: string; signature: string; payload: SalesPultPayload } | undefined;
      try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* нет или повреждён */ }
      if (cached?.day === today && cached.signature === signature && cached.payload?.asOfDate === month.to) {
        result[month.key] = cached.payload;
        continue;
      }
      const payload = await collect(month);
      result[month.key] = payload;
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ day: today, signature, payload }));
        fs.renameSync(`${file}.tmp`, file);
      } catch { console.warn(`[Пульт] Не удалось сохранить кэш ${month.key}`); }
    } catch {
      console.warn(`[Пульт] Месяц ${month.key} недоступен`);
      result[month.key] = null;
    }
  }
  return result;
}
