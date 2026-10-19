/**
 * Подтягивает в сделки по плану закупок смену товара: если заказчик заменил в пункте плана код ЕНС ТРУ и название,
 * в сделке обновляются поля «Код ЕНСТРУ», «Название ЕНСТРУ», «Код ТРУ», «Наименование», а название сделки и строка
 * «Item:» в комментарии меняются, только если их не правили руками. В ленту сделки пишется комментарий «План изменён заказчиком».
 * Сумма и количество здесь не трогаются: их ведёт bitrix-push-gz-deals (gzPlanRevision).
 *
 *   npx tsx scripts/bitrix-sync-gz-plan-items.mts                      просмотр, ничего не пишет
 *   npx tsx scripts/bitrix-sync-gz-plan-items.mts --execute --limit 5  записать первые 5 (пробный прогон)
 *   npx tsx scripts/bitrix-sync-gz-plan-items.mts --execute            записать все
 *
 * Нужны BITRIX24_WEBHOOK_URL (или --webhook-url) и GOSZAKUP_TOKEN.
 */

import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import { PLAN_ITEM_DEAL_SELECT, planItemSync, planRootsOf, type PlanItemDeal } from "../src/bitrix/gzPlanItemChange.js";
import { fetchCurrentPlanItems } from "../src/kz/goszakupPlanItems.js";

dotenv.config();

const SAMPLE_LINES = 20;

interface CliArgs {
  execute: boolean;
  limit: number | null;
  webhookUrl: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, limit: null, webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") args.execute = true;
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]) || null;
    else if (argv[i] === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else throw new Error(`Неизвестный параметр: ${argv[i]}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  const token = process.env.GOSZAKUP_TOKEN?.trim();
  if (!token) throw new Error("GOSZAKUP_TOKEN is required");

  const client = new BitrixClient(args.webhookUrl);
  console.log(`gz plan items sync: mode=${args.execute ? "execute" : "dry-run"}${args.limit ? ` limit=${args.limit}` : ""}`);

  const deals = (await client.listAll("deal", { "%ORIGIN_ID": "gz-plan:", STAGE_SEMANTIC_ID: "P" }, PLAN_ITEM_DEAL_SELECT)) as unknown as PlanItemDeal[];
  console.log(`открытых сделок по плану: ${deals.length}`);

  const roots = deals.flatMap((deal) => planRootsOf(deal));
  const { items, failed } = await fetchCurrentPlanItems(roots, { token });
  const plan = planItemSync(deals, items, new Set(failed));
  console.log(`план: ${JSON.stringify(plan.stats)}`);

  const updates = args.limit ? plan.updates.slice(0, args.limit) : plan.updates;
  let written = 0;
  let writeFailed = 0;
  for (const [index, update] of updates.entries()) {
    const line = `deal ${update.dealId}: ${update.previous.name || "?"} (${update.previous.code}) -> ${update.current.name} (${update.current.code})`;
    if (!args.execute) {
      if (index < SAMPLE_LINES) console.log(`[dry-run] ${line}`);
      continue;
    }
    try {
      // Без записи в живую ленту: массовая правка не должна рассылать уведомления по десяткам сделок.
      await client.call("crm.deal.update", { id: update.dealId, fields: update.fields, params: { REGISTER_SONET_EVENT: "N" } });
    } catch (error) {
      writeFailed += 1;
      console.error(`[failed] ${line}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await client.call("crm.timeline.comment.add", { fields: { ENTITY_ID: update.dealId, ENTITY_TYPE: "deal", COMMENT: update.comment } });
    } catch (error) {
      // Поля уже поправлены, а повторный запуск комментарий не допишет: ошибка видна в логе.
      console.error(`[comment failed] deal ${update.dealId}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    written += 1;
    console.log(`[updated] ${line}`);
  }
  if (!args.execute && updates.length > SAMPLE_LINES) console.log(`[dry-run] … и ещё ${updates.length - SAMPLE_LINES}`);
  console.log(`done: ${args.execute ? `updated=${written} failed=${writeFailed}` : `would_update=${updates.length}`} lookup_failed=${failed.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
