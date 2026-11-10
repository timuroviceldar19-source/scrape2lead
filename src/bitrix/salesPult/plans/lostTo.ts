import { flattenBitrixParams, type ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";
import type { NormalizedPlanDeal, PlanLostTo } from "./types.js";

// Формат пишет buildGzDealOutcomeComment (src/bitrix/gzDealOutcome.ts) для исхода "lost":
// «Итог закупки: выиграл <поставщик> (БИН <12 цифр>) — договор №<номер> от <дд.мм.гггг>[, <сумма> ₸]…».
// В названии поставщика могут быть скобки, поэтому БИН ищем как последнюю «(БИН …)» перед «— договор».
// Победу партнёра робот пишет как «выиграл наш партнёр …» — это не проигрыш.
const LOST_OUTCOME = /^Итог закупки: выиграл (?!наш партн[её]р )(.+) \(БИН (\d{12})\) — договор №\S+ от \d{2}\.\d{2}\.\d{4}(?:, ([\d\s\u00a0\u202f]+(?:,\d+)?) ₸)?/;
const ENTITIES: Record<string, string> = { "&quot;": '"', "&#039;": "'", "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": "\u00a0", "&amp;": "&" };
const decodeEntities = (s: string) => s.replace(/&(?:quot|#0?39|apos|lt|gt|nbsp|amp);/g, (m) => ENTITIES[m] ?? m);

export function parseLostOutcomeComment(comment: string | null | undefined): PlanLostTo | null {
  if (!comment) return null;
  const match = LOST_OUTCOME.exec(decodeEntities(String(comment)).trim());
  if (!match) return null;
  const [, name, bin, rawSum] = match;
  const contractSum = rawSum ? Number(rawSum.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".")) : null;
  return { name: name.trim(), bin, contractSum: contractSum !== null && Number.isFinite(contractSum) ? contractSum : null };
}

const BATCH_SIZE = 50;

/**
 * Для проигранных сделок по планам читает комментарии ленты (по 50 сделок в одном batch) и
 * записывает победителя из последнего комментария робота об исходе. Сбой не ломает «Планы»:
 * сделка остаётся без победителя и попадает в «без данных о победителе».
 */
export async function attachLostWinners(reader: ReadOnlyBitrixClient, deals: NormalizedPlanDeal[]): Promise<void> {
  const lost = deals.filter((d) => d.outcomeCategory === "lost");
  let failed = 0;
  for (let i = 0; i < lost.length; i += BATCH_SIZE) {
    const chunk = lost.slice(i, i + BATCH_SIZE);
    const cmd: Record<string, string> = {};
    for (const d of chunk) {
      cmd[`c${d.id}`] = `crm.timeline.comment.list?${flattenBitrixParams({
        filter: { ENTITY_ID: Number(d.id), ENTITY_TYPE: "deal" },
        select: ["ID", "COMMENT"]
      })}`;
    }
    try {
      const response = (await reader.call("batch", { halt: 0, cmd })) as { result?: Record<string, unknown> };
      const results = response?.result ?? {};
      for (const d of chunk) {
        const comments = results[`c${d.id}`];
        if (!Array.isArray(comments)) continue;
        let latest: { id: number; winner: PlanLostTo } | null = null;
        for (const c of comments as Array<{ ID?: unknown; COMMENT?: unknown }>) {
          const winner = parseLostOutcomeComment(typeof c.COMMENT === "string" ? c.COMMENT : null);
          const id = Number(c.ID) || 0;
          if (winner && (!latest || id > latest.id)) latest = { id, winner };
        }
        if (latest) d.lostTo = latest.winner;
      }
    } catch {
      // Текст ошибки транспорта может содержать адрес вебхука — не выводим его.
      failed += chunk.length;
    }
  }
  if (failed) console.warn(`[Планы] победители: не удалось прочитать комментарии ${failed} проигранных сделок`);
  const found = lost.filter((d) => d.lostTo).length;
  console.log(`[Планы] победители найдены у ${found} из ${lost.length} проигранных`);
}
