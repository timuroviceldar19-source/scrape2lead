import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { collectExternalProcurement } from "../src/kz/procurement/collector.js";
import { loadProcurementConfig } from "../src/kz/procurement/config.js";
import { classifyProcurementRecords } from "../src/kz/procurement/filter.js";
import { ProcurementStorage } from "../src/kz/procurement/storage.js";
import { buildProcurementWorkbookModel } from "../src/kz/procurement/workbookModel.js";
import { writeProcurementWorkbook } from "../src/kz/procurement/workbookWriter.js";

const args = parseArgs(process.argv.slice(2));
const config = loadProcurementConfig(args.config);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = path.resolve(args.outputDirectory ?? config.outputDirectory);
const xlsxPath = path.join(outputDirectory, `procurement-${stamp}.xlsx`);
const jsonPath = path.join(outputDirectory, `procurement-${stamp}.json`);
const databasePath = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(outputDirectory, { recursive: true });

const records = (await collectExternalProcurement({
  keywords: config.keywords,
  pageSize: args.pageSize ?? config.pageSize,
  maxPages: args.maxPages ?? config.maxPages,
  delayMs: args.delayMs ?? config.delayMs
})).filter((record) => config.sources.includes(record.source));

const database = new Database(databasePath);
try {
  const storage = new ProcurementStorage({ db: database });
  for (const record of records) storage.upsert(record);
} finally {
  database.close();
}

const classification = classifyProcurementRecords(records, {
  minAmount: config.minAmount,
  pkTruPrefixes: config.pkTruPrefixes,
  panelKeywords: config.panelKeywords,
  stopWords: config.stopWords
});
const model = buildProcurementWorkbookModel(classification);
await writeProcurementWorkbook(xlsxPath, model);
fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), config: args.config,
  summary: model.summary, classification }, null, 2), "utf8");

console.log(JSON.stringify({ mode: "xlsx-only", recordsCollected: records.length, ...model.summary,
  xlsxPath, jsonPath, databasePath }, null, 2));

function parseArgs(argv: string[]): { config: string; outputDirectory?: string; maxPages?: number; pageSize?: number; delayMs?: number } {
  const result: { config: string; outputDirectory?: string; maxPages?: number; pageSize?: number; delayMs?: number } = {
    config: "config/procurement-sources.json"
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--config" && value) { result.config = value; index++; }
    else if (arg === "--output" && value) { result.outputDirectory = value; index++; }
    else if (arg === "--max-pages" && value) { result.maxPages = positive(value, arg); index++; }
    else if (arg === "--page-size" && value) { result.pageSize = positive(value, arg); index++; }
    else if (arg === "--delay-ms" && value) { result.delayMs = nonnegative(value, arg); index++; }
    else if (arg === "--help") {
      console.log("tsx scripts/kz-export-procurement.mts [--config path] [--output dir] [--max-pages n] [--page-size n] [--delay-ms n]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return result;
}
function positive(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`); return parsed; }
function nonnegative(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`); return parsed; }
