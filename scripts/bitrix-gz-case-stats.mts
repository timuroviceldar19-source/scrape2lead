import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BitrixClient } from "../src/bitrix/client.js";
import { ReadOnlyBitrixClient } from "../src/bitrix/reporting/readOnlyClient.js";
import {
  GZ_CASE_DEAL_SELECT,
  GZ_CASE_ORIGINATORS,
  GZ_CASE_TITLE_MARK,
  formatGzCaseReport,
  summarizeGzCase,
  type GzCaseDeal
} from "../src/bitrix/reporting/gzCaseStats.js";

// Только чтение: цифры для кейса «сколько сделок завёл робот и сколько выиграно».
const REPORT_DIR = join("runs", "gz-case");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function listDeals(reader: ReadOnlyBitrixClient, filter: Record<string, unknown>): Promise<GzCaseDeal[]> {
  const deals: GzCaseDeal[] = [];
  let lastId = 0;
  for (;;) {
    const page = await reader.call("crm.deal.list", {
      filter: { ...filter, ">ID": lastId },
      order: { ID: "ASC" },
      select: GZ_CASE_DEAL_SELECT,
      start: -1
    }) as GzCaseDeal[];
    if (!Array.isArray(page) || page.length === 0) return deals;
    deals.push(...page);
    lastId = Number(page[page.length - 1].ID);
  }
}

async function main(): Promise<void> {
  const asOfDate = arg("--as-of") ?? new Date().toISOString().slice(0, 10);
  const minutesPerDeal = Number(arg("--minutes-per-deal") ?? 10);
  if (!Number.isFinite(minutesPerDeal) || minutesPerDeal < 0) throw new Error("--minutes-per-deal must be a non-negative number");
  const webhookUrl = process.env.BITRIX24_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

  const reader = new ReadOnlyBitrixClient(new BitrixClient(webhookUrl, { requestDelayMs: 550, maxRetries: 5 }));
  const deals: GzCaseDeal[] = [];
  for (const originatorId of Object.keys(GZ_CASE_ORIGINATORS)) {
    deals.push(...await listDeals(reader, { ORIGINATOR_ID: originatorId }));
  }
  deals.push(...await listDeals(reader, { "%TITLE": GZ_CASE_TITLE_MARK }));

  const summary = summarizeGzCase(deals, { minutesPerDeal });
  const report = formatGzCaseReport(summary, asOfDate);
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, `${asOfDate}.json`), JSON.stringify(summary, null, 2));
  await writeFile(join(REPORT_DIR, `${asOfDate}.md`), report);
  console.log(report);
  console.log(`Отчёт: ${join(REPORT_DIR, `${asOfDate}.md`)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
