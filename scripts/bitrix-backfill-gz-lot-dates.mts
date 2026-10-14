/**
 * Исправляет срок приёма заявок (`BEGINDATE`/`CLOSEDATE`) у открытых сделок по лотам.
 *
 * Раньше импорт этих дат не передавал, и Bitrix ставил «по умолчанию» день создания и +7 дней.
 * Скрипт берёт настоящие даты из реестра и меняет только те сделки, где стоят именно такие «по умолчанию»:
 * даты, которые менеджер поправил сам, не трогаются. Остальные поля сделки не меняются.
 *
 *   npx tsx scripts/bitrix-backfill-gz-lot-dates.mts                    просмотр, ничего не пишет
 *   npx tsx scripts/bitrix-backfill-gz-lot-dates.mts --execute --limit 5  записать первые 5 (пробный прогон)
 *   npx tsx scripts/bitrix-backfill-gz-lot-dates.mts --execute          записать все
 *
 * Нужны BITRIX24_WEBHOOK_URL (или --webhook-url) и GOSZAKUP_TOKEN.
 */

import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import { planLotDateBackfill, type LotDateDeal } from "../src/bitrix/gzLotDates.js";
import { fetchLotBidWindows } from "../src/kz/goszakupLotWindow.js";

dotenv.config();

const DEAL_SELECT = ["ID", "ORIGIN_ID", "DATE_CREATE", "BEGINDATE", "CLOSEDATE"];
const SAMPLE_LINES = 15;

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
  console.log(`gz lot dates backfill: mode=${args.execute ? "execute" : "dry-run"}${args.limit ? ` limit=${args.limit}` : ""}`);

  const deals = (await client.listAll("deal", { "%ORIGIN_ID": "gz-lot:", STAGE_SEMANTIC_ID: "P" }, DEAL_SELECT)) as unknown as LotDateDeal[];
  console.log(`открытых сделок по лотам: ${deals.length}`);

  const lotNumbers = deals.map((deal) => String(deal.ORIGIN_ID ?? "").replace(/^gz-lot:/, "")).filter(Boolean);
  const { windows, failed } = await fetchLotBidWindows(lotNumbers, { token });
  const plan = planLotDateBackfill(deals, windows, new Set(failed));
  console.log(`план: ${JSON.stringify(plan.stats)}`);

  const updates = args.limit ? plan.updates.slice(0, args.limit) : plan.updates;
  let written = 0;
  let writeFailed = 0;
  for (const [index, update] of updates.entries()) {
    const line = `deal ${update.dealId} gz-lot:${update.lotNumber} <- ${JSON.stringify(update.fields)}`;
    if (!args.execute) {
      if (index < SAMPLE_LINES) console.log(`[dry-run] ${line}`);
      continue;
    }
    try {
      // Без записи в живую ленту: массовая правка дат не должна рассылать уведомления по сотне сделок.
      await client.call("crm.deal.update", { id: update.dealId, fields: update.fields, params: { REGISTER_SONET_EVENT: "N" } });
      written += 1;
      console.log(`[updated] ${line}`);
    } catch (error) {
      writeFailed += 1;
      console.error(`[failed] ${line}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  if (!args.execute && updates.length > SAMPLE_LINES) console.log(`[dry-run] … и ещё ${updates.length - SAMPLE_LINES}`);
  console.log(`done: ${args.execute ? `updated=${written} failed=${writeFailed}` : `would_update=${updates.length}`} lookup_failed=${failed.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
