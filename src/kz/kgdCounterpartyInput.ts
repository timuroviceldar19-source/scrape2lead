import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

import type { CaptchaMode } from "./kgdCaptchaMode.js";

export interface CounterpartyArgs { input: string; limit: number; captchaMode: CaptchaMode | undefined }
export interface BinInputResult { bins: string[]; totalRows: number; invalidRows: number; duplicateRows: number; limitSkipped: number }

export function isValidCounterpartyBin(value: string): boolean { return /^\d{12}$/.test(value); }

export function parseCounterpartyArgs(argv: string[]): CounterpartyArgs {
  let input = "";
  let limit = 20;
  let captchaMode: CaptchaMode | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") input = argv[++i] ?? "";
    else if (argv[i] === "--limit") {
      const raw = argv[++i] ?? "";
      limit = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
    } else if (argv[i] === "--captcha-mode") {
      const value = argv[++i];
      if (value !== "auto" && value !== "manual") throw new Error("--captcha-mode must be auto or manual");
      captchaMode = value;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!input) throw new Error("--input <file.xlsx|csv> is required");
  if (!/\.(csv|xlsx)$/i.test(input)) throw new Error("Input must be a CSV or XLSX file");
  return { input, limit, captchaMode };
}

export async function readCounterpartyBins(file: string, limit = 20): Promise<BinInputResult> {
  if (!fs.existsSync(file)) throw new Error(`Input file not found: ${file}`);
  const rows = path.extname(file).toLowerCase() === ".csv" ? readCsv(fs.readFileSync(file, "utf8")) : await readXlsx(file);
  if (rows.length === 0) throw new Error("Input is empty");
  const header = rows[0].map(normalizeHeader);
  const binIndex = header.findIndex((value) => ["бин", "bin", "бин(иин)", "бин/иин"].includes(value));
  if (binIndex < 0) throw new Error("BIN column not found (expected БИН, БИН(ИИН), or БИН/ИИН)");
  const seen = new Set<string>();
  const unique: string[] = [];
  let invalidRows = 0, duplicateRows = 0;
  for (const row of rows.slice(1)) {
    const bin = String(row[binIndex] ?? "").trim();
    if (!isValidCounterpartyBin(bin)) { invalidRows++; continue; }
    if (seen.has(bin)) { duplicateRows++; continue; }
    seen.add(bin); unique.push(bin);
  }
  return { bins: unique.slice(0, limit), totalRows: Math.max(0, rows.length - 1), invalidRows, duplicateRows, limitSkipped: Math.max(0, unique.length - limit) };
}

function normalizeHeader(value: unknown): string { return String(value ?? "").toLocaleLowerCase("ru").replace(/\s+/g, "").replace(/[\\|]/g, "/"); }
function readCsv(text: string): string[][] {
  const delimiter = (text.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) > (text.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  return text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0).map((line) => parseCsvLine(line, delimiter));
}
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = []; let value = ""; let quoted = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; } else if (ch === '"') quoted = !quoted; else if (ch === delimiter && !quoted) { result.push(value); value = ""; } else value += ch; }
  result.push(value); return result;
}
async function readXlsx(file: string): Promise<unknown[][]> {
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file); const sheet = book.worksheets[0]; if (!sheet) return [];
  const rows: unknown[][] = []; sheet.eachRow({ includeEmpty: true }, (row) => rows.push((row.values as unknown[]).slice(1))); return rows;
}
