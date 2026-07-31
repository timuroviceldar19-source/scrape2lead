import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { buildGoszakupLeadCandidates, type LeadContract, type LeadRegistryRecord } from "../src/kz/goszakupLeads.js";
import { writeGoszakupLeadWorkbook } from "../src/kz/goszakupLeadWorkbook.js";
import { collectGoszakupRegistryForBins } from "../src/kz/goszakupRegistryCollector.js";
import { KzStorage } from "../src/kz/kzStorage.js";
import { chromium } from "playwright";
import { parseContractGeneralHtml, parseContractPartiesHtml, parseContractSearchHtml, parseContractUnitNamesHtml } from "../src/kz/goszakupContractParser.js";

const ConfigSchema = z.object({
  includePrefixes: z.array(z.string().regex(/^\d+$/)).min(1),
  excludePrefixes: z.array(z.string().regex(/^\d+$/)).default([]),
  historyMonths: z.number().int().positive().default(18),
  currentMonths: z.number().int().positive().default(3),
  cities: z.array(z.enum(["Астана", "Алматы"])).default(["Астана", "Алматы"]),
  limit: z.number().int().positive().optional(),
  maxPages: z.number().int().positive().default(500),
  delayMs: z.number().int().nonnegative().default(350),
  registryDelayMs: z.number().int().nonnegative().default(1000),
  headless: z.boolean().default(true),
  databasePath: z.string().default("data/scrape2lead.db")
});

interface CliArgs {
  configPath: string;
  from?: string;
  to?: string;
  limit?: number;
  headless?: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const config = ConfigSchema.parse(await readJson(args.configPath));
  const now = parseIsoDate(args.to ?? localIsoDate(new Date()), "--to");
  const historyFrom = args.from ?? isoMonthsAgo(now, config.historyMonths);
  const currentFrom = isoMonthsAgo(now, config.currentMonths);
  if (historyFrom > localIsoDate(now)) throw new Error("--from must not be after --to");

  const contracts = await collectContractsByPrefixes(config.includePrefixes, config.excludePrefixes, historyFrom, localIsoDate(now));
  const outputPath = path.join("exports", `gz-leads-it-${localIsoDate(now)}.xlsx`);

  const preliminary = buildGoszakupLeadCandidates({
    now, currentFrom, historyFrom, contracts, registryByBin: new Map(), callLimit: args.limit ?? config.limit
  });
  const bins = preliminary.candidates.map((candidate) => candidate.bin);
  const databasePath = path.resolve(config.databasePath);
  const registryStats = await collectGoszakupRegistryForBins(bins, {
    databasePath,
    delayMs: config.registryDelayMs,
    headless: args.headless ?? config.headless,
    requireName: false,
    requireContacts: false,
    onProgress: (index, total, bin) => console.log(`gz-leads: registry ${index}/${total} ${bin}`)
  });
  const registryByBin = loadRegistry(databasePath, bins);
  const result = buildGoszakupLeadCandidates({
    now, currentFrom, historyFrom, contracts, registryByBin, callLimit: args.limit ?? config.limit
  });
  await writeGoszakupLeadWorkbook({
    outPath: outputPath,
    callLeads: result.callLeads,
    otherCityLeads: result.otherCityLeads,
    withoutPhoneLeads: result.withoutPhoneLeads
  });

  console.log(`кандидатов=${result.candidates.length}`);
  console.log(`с телефоном=${result.phoneLeads.length}`);
  console.log(`попало в список=${result.callLeads.length}`);
  console.log(`другие города=${result.otherCityLeads.length} без телефона=${result.withoutPhoneLeads.length}`);
  console.log(`реестр: обработано=${registryStats.processed} успешно=${registryStats.success} кэш=${registryStats.cached}`);
  console.log(`файл=${outputPath}`);
}

async function collectContractsByPrefixes(include: string[], exclude: string[], from: string, to: string): Promise<LeadContract[]> {
  const browser = await chromium.launch({ headless: true }); const rows: LeadContract[] = [];
  try { const page = await browser.newPage({ locale: "ru-RU" });
    const url = (pageNo: number) => { const p = new URLSearchParams({ "filter[start_date_from]": from, "filter[start_date_to]": to, count_record: "50" }); if (pageNo > 1) p.set("page", String(pageNo)); return `https://www.goszakup.gov.kz/ru/registry/contract?${p}`; };
    await page.goto(url(1), { waitUntil: "domcontentloaded", timeout: 45_000 }); let search = parseContractSearchHtml(await page.content(), 50); const total = search.pagination.totalPages;
    for (let pageNo = 1; pageNo <= total; pageNo++) { if (pageNo > 1) { await page.goto(url(pageNo), { waitUntil: "domcontentloaded", timeout: 45_000 }); search = parseContractSearchHtml(await page.content(), 50); } console.log(`gz-leads: contracts page=${pageNo}/${total}`);
      for (const item of search.items) { await page.goto(`https://www.goszakup.gov.kz/ru/egzcontract/cpublic/show/${item.contractId}`, { waitUntil: "domcontentloaded", timeout: 45_000 }); const signedAt = parseContractGeneralHtml(await page.content()).signedAt?.slice(0, 10); if (!signedAt) continue;
        await page.goto(`https://www.goszakup.gov.kz/ru/egzcontract/cpublic/units/${item.contractId}`, { waitUntil: "domcontentloaded", timeout: 45_000 }); const units = parseContractUnitNamesHtml(await page.content()).filter((unit) => include.some((prefix) => unit.code.startsWith(prefix)) && !exclude.some((prefix) => unit.code.startsWith(prefix))); if (!units.length) continue;
        await page.goto(`https://www.goszakup.gov.kz/ru/egzcontract/cpublic/customer_n_supplier/${item.contractId}`, { waitUntil: "domcontentloaded", timeout: 45_000 }); const parties = parseContractPartiesHtml(await page.content());
        for (const unit of units) rows.push({ bin: parties.supplierBinIin, supplierName: parties.supplierName, signedAt, contractId: item.contractId, contractNumber: item.contractNumber, customerName: parties.customerName, customerBin: parties.customerBin, amount: item.amount, searchCode: unit.code });
      }
    } return rows;
  } finally { await browser.close(); }
}

function loadRegistry(databasePath: string, bins: string[]): Map<string, LeadRegistryRecord> {
  const storage = new KzStorage({ databasePath });
  try {
    return new Map(bins.map((bin) => {
      const record = storage.getGoszakupRegistryByBin(bin);
      return [bin, {
        bin,
        nameRu: record?.name_ru ?? null,
        phone: record?.phone ?? null,
        fullAddressRu: record?.full_address_ru ?? null,
        legalAddress: record?.legal_address ?? null,
        locationAddress: record?.location_address ?? null,
        economicSector: record?.economic_sector ?? null,
        okedList: record?.oked_list ?? null,
        registryUrl: record?.registry_url ?? null
      }];
    }));
  } finally {
    storage.close();
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { configPath: "config/gz-leads-it.json", help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => argv[++index] ?? (() => { throw new Error(`${arg} requires a value`); })();
    if (arg === "--config") args.configPath = value();
    else if (arg === "--from") args.from = value();
    else if (arg === "--to") args.to = value();
    else if (arg === "--limit") args.limit = positiveInteger(value(), "--limit");
    else if (arg === "--headful" || arg === "--headed") args.headless = false;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function readJson(filePath: string): Promise<unknown> {
  const fs = await import("node:fs/promises");
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function parseIsoDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function isoMonthsAgo(now: Date, months: number): string {
  return localIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())));
}

function localIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printHelp(): void {
  console.log(`Export IT-equipment supplier leads from goszakup contracts.\n\nUsage:\n  npm run kz:export-leads-it -- [options]\n\nOptions:\n  --config <path>       JSON config (default: config/gz-leads-it.json)\n  --from <YYYY-MM-DD>   Start of history window\n  --to <YYYY-MM-DD>     End of history window (default: today)\n  --limit <n>           Maximum leads on the Лиды sheet\n  --headful             Show Chromium\n  --headless            Run Chromium hidden`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
