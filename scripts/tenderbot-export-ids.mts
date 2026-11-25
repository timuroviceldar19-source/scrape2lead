/**
 * Выгрузка ID лотов Tenderbot по нашим товарам через внутренний API сайта.
 *
 * Примеры:
 *   npx tsx scripts/tenderbot-export-ids.mts --config config/gz-lots-computers.json --max-pages 5
 *   npx tsx scripts/tenderbot-export-ids.mts --keywords "ноутбук,монитор" --per-page 400
 *   npx tsx scripts/tenderbot-export-ids.mts --keywords "принтер" --amount-from 500000 --region 7522887
 *
 * Логин и пароль сайта — в .env: TENDERBOT_LOGIN, TENDERBOT_PASSWORD.
 * Платный токен API для этого не нужен.
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { sleep } from "../src/kz/csv.js";
import {
  TENDERBOT_API_BASE,
  TENDERBOT_MAX_PER_PAGE,
  TenderbotInternalClient,
  type TenderbotLot,
  type TenderbotSearchFilters
} from "../src/kz/tenderbotInternalClient.js";

dotenv.config();

const ConfigSchema = z.object({
  keywords: z.array(z.string().min(1)).default([]),
  excludeKeywords: z.array(z.string().min(1)).default([]),
  truCodes: z.array(z.string().min(1)).default([]),
  regionIds: z.array(z.coerce.number().int().positive()).default([]),
  subject: z.array(z.enum(["1", "2", "3"])).default([]),
  minAmount: z.coerce.number().nonnegative().optional(),
  maxAmount: z.coerce.number().nonnegative().optional(),
  delayMs: z.coerce.number().int().nonnegative().optional(),
  maxPages: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().optional(),
  outDir: z.string().optional()
});

type Config = z.infer<typeof ConfigSchema>;

interface CliArgs {
  configPath: string | undefined;
  keywords: string[];
  excludeKeywords: string[];
  truCodes: string[];
  regionIds: number[];
  subject: Array<"1" | "2" | "3">;
  minAmount: number | undefined;
  maxAmount: number | undefined;
  delayMs: number | undefined;
  maxPages: number | undefined;
  perPage: number | undefined;
  outDir: string | undefined;
  combined: boolean;
}

const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: undefined,
    keywords: [],
    excludeKeywords: [],
    truCodes: [],
    regionIds: [],
    subject: [],
    minAmount: undefined,
    maxAmount: undefined,
    delayMs: undefined,
    maxPages: undefined,
    perPage: undefined,
    outDir: undefined,
    combined: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") args.configPath = argv[++i];
    else if (arg === "--keywords" || arg === "-k") args.keywords.push(...splitList(argv[++i]));
    else if (arg === "--exclude") args.excludeKeywords.push(...splitList(argv[++i]));
    else if (arg === "--tru") args.truCodes.push(...splitList(argv[++i]));
    else if (arg === "--region") args.regionIds.push(...splitList(argv[++i]).map(Number));
    else if (arg === "--subject") args.subject.push(...splitList(argv[++i]) as Array<"1" | "2" | "3">);
    else if (arg === "--amount-from") args.minAmount = Number(argv[++i]);
    else if (arg === "--amount-to") args.maxAmount = Number(argv[++i]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i]);
    else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (arg === "--per-page") args.perPage = Number(argv[++i]);
    else if (arg === "--out") args.outDir = argv[++i];
    else if (arg === "--combined") args.combined = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("См. шапку скрипта и docs/tenderbot-internal-api.md");
      process.exit(0);
    } else {
      console.warn(`Неизвестный аргумент: ${arg}`);
    }
  }

  return args;
}

function loadConfig(configPath: string | undefined): Config {
  if (!configPath) return ConfigSchema.parse({});
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  return ConfigSchema.parse(raw);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function lotToCsv(lot: TenderbotLot, keyword: string): string {
  return [
    lot.id,
    lot.sourceId,
    lot.gzid,
    lot.goszakupLink,
    lot.name,
    lot.amount,
    lot.customer,
    lot.customerBin,
    lot.ktru,
    lot.measure,
    lot.count,
    lot.pricePerUnit,
    lot.deliveryPlace,
    lot.openDate,
    lot.closeDate,
    lot.status,
    lot.method,
    keyword
  ].map(csvCell).join(";");
}

const CSV_HEADER = [
  "id",
  "source_id",
  "gzid",
  "goszakup_link",
  "name",
  "amount",
  "customer",
  "customer_bin",
  "ktru",
  "measure",
  "count",
  "price_per_unit",
  "delivery_place",
  "open_date",
  "close_date",
  "status",
  "method",
  "keyword"
].join(";");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);

  const keywords = args.keywords.length > 0 ? args.keywords : config.keywords;
  if (keywords.length === 0) {
    console.error("Нет ключевых слов: передайте --keywords или --config с полем keywords.");
    process.exit(1);
  }

  const login = process.env.TENDERBOT_LOGIN?.trim();
  const password = process.env.TENDERBOT_PASSWORD?.trim();
  if (!login || !password) {
    console.error("Заполните TENDERBOT_LOGIN и TENDERBOT_PASSWORD в .env (это логин обычного аккаунта tenderbot.kz).");
    process.exit(1);
  }

  const delayMs = args.delayMs ?? config.delayMs ?? Number(process.env.TENDERBOT_DELAY_MS ?? 1200);
  const maxPages = args.maxPages ?? config.maxPages ?? 200;
  const perPage = Math.min(args.perPage ?? config.perPage ?? TENDERBOT_MAX_PER_PAGE, TENDERBOT_MAX_PER_PAGE);
  const outDir = args.outDir ?? config.outDir
    ?? path.join("outputs", `tenderbot-ids-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  const client = new TenderbotInternalClient({
    apiBaseUrl: process.env.TENDERBOT_API_BASE ?? TENDERBOT_API_BASE,
    login,
    password,
    delayMs
  });

  const searchAll = args.combined ? [keywords.join(",")] : keywords;
  const baseFilters: TenderbotSearchFilters = {
    excluded: args.excludeKeywords.length > 0 ? args.excludeKeywords : config.excludeKeywords,
    truCodes: args.truCodes.length > 0 ? args.truCodes : config.truCodes,
    regionIds: args.regionIds.length > 0 ? args.regionIds : config.regionIds,
    subject: args.subject.length > 0 ? args.subject : config.subject,
    amountFrom: args.minAmount ?? config.minAmount,
    amountTo: args.maxAmount ?? config.maxAmount
  };

  console.log(`Tenderbot: ${searchAll.length} запрос(ов), per_page=${perPage}, пауза ${delayMs} мс`);
  console.log(`Логин: ${login}`);
  console.log(`Логинимся в ${process.env.TENDERBOT_API_BASE ?? TENDERBOT_API_BASE} ...`);
  await client.login();

  fs.mkdirSync(outDir, { recursive: true });
  const lotsPath = path.join(outDir, "lots.json");
  const csvPath = path.join(outDir, "ids.csv");
  const summaryPath = path.join(outDir, "summary.json");
  fs.writeFileSync(csvPath, `\uFEFF${CSV_HEADER}\r\n`, "utf8");

  const allLots = new Map<number, { lot: TenderbotLot; keyword: string }>();
  const summary: Array<{ keyword: string; total: number; fetched: number; pages: number }> = [];
  let pagesUsed = 0;

  for (const keyword of searchAll) {
    let fetched = 0;
    let pages = 0;
    const result = await client.searchAll(
      { ...baseFilters, searchstr: keyword },
      {
        maxPages,
        perPage,
        onPage: (page) => {
          pages = page.currentPage;
          pagesUsed++;
          process.stdout.write(`\r  "${keyword}": страница ${page.currentPage}/${page.lastPage}, всего ${page.total}   `);
        }
      }
    );
    for (const lot of result.lots) {
      if (!allLots.has(lot.id)) allLots.set(lot.id, { lot, keyword });
    }
    if (result.lots.length > 0) {
      fs.appendFileSync(csvPath, result.lots.map((lot) => lotToCsv(lot, keyword)).join("\r\n") + "\r\n", "utf8");
    }
    fetched = result.lots.length;
    summary.push({ keyword, total: result.total, fetched, pages });
    process.stdout.write(`\r  "${keyword}": ${result.total} лотов, выгружено ${result.lots.length} за ${pages} стр.${" ".repeat(6)}\n`);
    if (keyword !== searchAll.at(-1)) await sleep(delayMs);
  }

  const unique = [...allLots.values()].map(({ lot, keyword }) => ({ ...lot, keyword }));
  fs.writeFileSync(lotsPath, JSON.stringify({ generatedAt: new Date().toISOString(), unique: unique.length, lots: unique }, null, 1), "utf8");
  fs.writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), delayMs, perPage, keywords: summary }, null, 1), "utf8");

  const totalHits = summary.reduce((sum, item) => sum + item.total, 0);
  console.log("\nИтого:");
  for (const item of summary) console.log(`  ${item.keyword}: ${item.total}`);
  console.log(`  Уникальных ID: ${unique.length} (сумма совпадений ${totalHits})`);
  console.log(`  Запросов к API: ${pagesUsed}`);
  console.log(`\nФайлы:\n  ${csvPath}\n  ${lotsPath}\n  ${summaryPath}`);
}

main().catch((error: unknown) => {
  console.error(`\nОшибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
