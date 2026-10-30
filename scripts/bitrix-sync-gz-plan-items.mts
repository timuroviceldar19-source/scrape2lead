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
 * Нужен BITRIX24_WEBHOOK_URL (или --webhook-url); GOSZAKUP_TOKEN — только для резерва.
 */

import dotenv from "dotenv";
import { BitrixClient } from "../src/bitrix/client.js";
import { PLAN_ITEM_DEAL_SELECT, planItemSync, planRootsOf, type PlanItemDeal } from "../src/bitrix/gzPlanItemChange.js";
import { fetchCurrentPlanItems } from "../src/kz/goszakupPlanItems.js";
import { GzPlanLookup, type GzPlanContext } from "../src/kz/zakupGzPlans.js";
import { fullEnstruCodes } from "../src/kz/zakupGzRegistry.js";
import { buildGzDealPlanRef } from "../src/bitrix/gzDealOutcome.js";
import fs from "node:fs";
import path from 'node:path';
import { PortalPlanVerifier } from '../src/kz/goszakupPlanRegistry.js';
import { filterVerifiedPlanItemUpdates } from '../src/bitrix/gzPlanItemPortal.js';

dotenv.config();

const SAMPLE_LINES = 20;

interface CliArgs {
  execute: boolean;
  limit: number | null;
  webhookUrl: string | null;
  reportPath: string | null;
  maxFullScans: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, limit: null, webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null, reportPath: null, maxFullScans: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") args.execute = true;
    else if (argv[i] === "--limit") args.limit = Number(argv[++i]) || null;
    else if (argv[i] === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (argv[i] === "--report") args.reportPath = argv[++i] ?? null;
    else if (argv[i] === '--max-full-scans') {
      const value = argv[++i] ?? '';
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--max-full-scans requires a nonnegative integer');
      args.maxFullScans = Number(value);
    }
    else throw new Error(`Неизвестный параметр: ${argv[i]}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");
  const token = process.env.GOSZAKUP_TOKEN?.trim();

  const client = new BitrixClient(args.webhookUrl);
  console.log(`gz plan items sync: mode=${args.execute ? "execute" : "dry-run"}${args.limit ? ` limit=${args.limit}` : ""}`);

  const deals = (await client.listAll("deal", { "%ORIGIN_ID": "gz-plan:", STAGE_SEMANTIC_ID: "P" }, PLAN_ITEM_DEAL_SELECT)) as unknown as PlanItemDeal[];
  console.log(`открытых сделок по плану: ${deals.length}`);

  const roots = deals.flatMap((deal) => planRootsOf(deal));
  const contexts = new Map<number, GzPlanContext>();
  for (const deal of deals) {
    const bin = deal.UF_CRM_6627AEBD7C2D2 || /BIN:\s*(\d{12})/.exec(deal.COMMENTS ?? "")?.[1] || "";
    const year = Number(deal.DATE_CREATE?.slice(0, 4));
    if (/^\d{12}$/.test(bin) && year) {
      const context = { bin, year, codes: fullEnstruCodes(deal.UF_CRM_REF_ENSTRU_CODE, deal.UF_CRM_6A436D5A19612), pointIds: buildGzDealPlanRef(deal).pointIds };
      for (const root of planRootsOf(deal)) contexts.set(root, context);
    }
  }
  const lookup = new GzPlanLookup({ token, contexts, maxFullScans: args.maxFullScans });
  console.log(`lookup_input=${JSON.stringify({ deals: deals.length, without_enstru: deals.filter(deal => !fullEnstruCodes(deal.UF_CRM_REF_ENSTRU_CODE, deal.UF_CRM_6A436D5A19612).length).length })}`);
  const { items, failed } = await fetchCurrentPlanItems(roots, { token, contexts, lookup });
  const plan = planItemSync(deals, items, new Set(failed));
  const portal = new PortalPlanVerifier();
  const verified = await filterVerifiedPlanItemUpdates(plan.updates, portal);
  const candidates = plan.updates;
  plan.updates = verified.updates;
  plan.stats.willUpdate = plan.updates.length;
  plan.stats.skipped += verified.skipped.length;
  for (const item of verified.skipped) console.log(`[${item.reason}] plan ${item.planNumber}: ${item.message}`);
  console.log(`portal_verification=${JSON.stringify(portal.stats)}`);
  if (args.reportPath) {
    fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
    fs.writeFileSync(args.reportPath, JSON.stringify({ mode: args.execute ? "execute" : "dry-run", ...plan, failed,
      candidates, sourceSkipped: verified.skipped, portalVerification: portal.stats }, null, 2));
  }
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
  console.log(`lookup_stats=${JSON.stringify({ full_scan_plans_attempted: lookup.fullScanPlans.size, full_scan_customers: lookup.fullScanBins.size, plan_sources: Object.fromEntries(["q", "enstru", "lots", "full", "ows"].map(path => [path, [...lookup.planSources.values()].filter(value => value === path).length])) })}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
