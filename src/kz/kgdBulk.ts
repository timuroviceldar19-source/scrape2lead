import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import type { BulkMatch, BulkSource } from "./kgdCounterpartyTypes.js";

export interface BulkWorkbookOptions { source: BulkSource; sourceUrl: string; listDate: string }
export interface CacheMetadata { sourceUrl: string; attachmentUrl: string; downloadedAt: string; listDate: string; sha256: string; fileName: string }
export type CacheAction = "use" | "refresh_with_fallback" | "expired";

export function resolveCacheAction(ageHours: number): CacheAction { return ageHours < 24 ? "use" : ageHours < 24 * 7 ? "refresh_with_fallback" : "expired"; }

export function chooseSpreadsheetAttachment(pageUrl: string, html: string, preferredPattern?: RegExp): string {
  const links = [...html.matchAll(/href\s*=\s*["']([^"']+\.(?:xlsx?|XLSX?)(?:\?[^"']*)?)["']/g)].map((m) => new URL(m[1], pageUrl).href);
  let unique = [...new Set(links)]; if (preferredPattern) { const preferred = unique.filter((url) => preferredPattern.test(url)); if (preferred.length) unique = preferred.sort((a, b) => (inferListDateFromUrl(b) ?? "").localeCompare(inferListDateFromUrl(a) ?? "")); }
  if (unique.length === 0) throw new Error("No XLS/XLSX attachment found"); if (unique.length > 1 && !preferredPattern) throw new Error(`Ambiguous spreadsheet attachments: ${unique.join(", ")}`); return unique[0];
}

export async function parseBulkWorkbook(data: Buffer | ArrayBuffer, options: BulkWorkbookOptions): Promise<BulkMatch[]> {
  const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return parseLegacyWorkbook(bytes, options);
  const book = new ExcelJS.Workbook(); try { await book.xlsx.load(bytes as never); } catch (error) { throw new Error(`Corrupt or unsupported bulk workbook: ${String(error)}`); }
  const output: BulkMatch[] = [];
  for (const sheet of book.worksheets) {
    let headerRow = 0, binColumn = 0, nameColumn = 0;
    sheet.eachRow((row, rowNumber) => { if (headerRow) return; const cells = (row.values as unknown[]).slice(1).map(normalizeCell); const found = cells.findIndex(isBinHeader); if (found >= 0) { headerRow = rowNumber; binColumn = found + 1; nameColumn = cells.findIndex((v) => /^(наименование|название|наименование должника|наименование\/ф\.и\.о\.)$/.test(v)) + 1; } });
    if (!headerRow) continue;
    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) { const row = sheet.getRow(rowNumber); const bin = cellText(row.getCell(binColumn).value); if (!/^\d{12}$/.test(bin)) continue; output.push({ bin, name: nameColumn ? cellText(row.getCell(nameColumn).value) : "", listType: sheet.name, ...options }); }
  }
  return output;
}

function parseLegacyWorkbook(data: Uint8Array, options: BulkWorkbookOptions): BulkMatch[] {
  try {
    const book = XLSX.read(data, { type: "buffer", raw: true }); const output: BulkMatch[] = [];
    for (const sheetName of book.SheetNames) { const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName], { header: 1, raw: true }); const headerRow = rows.findIndex((row) => row.some((cell) => isBinHeader(normalizeCell(cell)))); if (headerRow < 0) continue; const headers = rows[headerRow].map(normalizeCell); const binColumn = headers.findIndex(isBinHeader); const nameColumn = headers.findIndex((v) => /^(наименование|название|наименование должника)$/.test(v)); for (const row of rows.slice(headerRow + 1)) { const bin = cellText(row[binColumn]); if (/^\d{12}$/.test(bin)) output.push({ bin, name: nameColumn >= 0 ? cellText(row[nameColumn]) : "", listType: sheetName, ...options }); } }
    return output;
  } catch (error) { throw new Error(`Corrupt or unsupported legacy XLS workbook: ${String(error)}`); }
}

export async function downloadAndCacheBulk(pageUrl: string, cacheDir: string, cacheKey: string, listDate: string, fetcher: typeof fetch = fetch, preferredPattern?: RegExp): Promise<{ data: Buffer; metadata: CacheMetadata }> {
  const page = await fetcher(pageUrl); if (!page.ok) throw new Error(`Bulk page HTTP ${page.status}`); const attachmentUrl = chooseSpreadsheetAttachment(pageUrl, await page.text(), preferredPattern); const response = await fetcher(attachmentUrl); if (!response.ok) throw new Error(`Bulk attachment HTTP ${response.status}`); const data = Buffer.from(await response.arrayBuffer()); const effectiveListDate = inferListDateFromUrl(attachmentUrl) ?? listDate;
  const extension = path.extname(new URL(attachmentUrl).pathname).toLowerCase() || ".xlsx"; fs.mkdirSync(cacheDir, { recursive: true }); const fileName = `${cacheKey}${extension}`; const metadata: CacheMetadata = { sourceUrl: pageUrl, attachmentUrl, downloadedAt: new Date().toISOString(), listDate: effectiveListDate, sha256: crypto.createHash("sha256").update(data).digest("hex"), fileName };
  atomicWrite(path.join(cacheDir, fileName), data); atomicWrite(path.join(cacheDir, `${cacheKey}.json`), Buffer.from(JSON.stringify(metadata, null, 2))); return { data, metadata };
}

export function readBulkCache(cacheDir: string, cacheKey: string): { data: Buffer; metadata: CacheMetadata } | null { const metadataPath = path.join(cacheDir, `${cacheKey}.json`); if (!fs.existsSync(metadataPath)) return null; const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as CacheMetadata; const file = path.join(cacheDir, metadata.fileName); if (!fs.existsSync(file)) return null; const data = fs.readFileSync(file); if (crypto.createHash("sha256").update(data).digest("hex") !== metadata.sha256) return null; return { data, metadata }; }
function atomicWrite(target: string, data: Buffer): void { const temp = `${target}.${process.pid}.tmp`; fs.writeFileSync(temp, data); fs.renameSync(temp, target); }
function normalizeCell(value: unknown): string { return cellText(value).toLocaleLowerCase("ru").replace(/\s+/g, "").replace(/[\\|]/g, "/"); }
function isBinHeader(value: string): boolean { return ["бин", "бин(иин)", "бин/иин", "иин/бин", "иин(бин)"].includes(value); }
function cellText(value: unknown): string { if (value === null || value === undefined) return ""; if (typeof value === "object" && "text" in value) return String((value as { text: unknown }).text).trim(); if (typeof value === "number") return Number.isSafeInteger(value) ? String(value).padStart(12, "0") : String(value); return String(value).trim(); }
function inferListDateFromUrl(url: string): string | undefined { const decoded = decodeURIComponent(url); const matches = [...decoded.matchAll(/(\d{2})[._-](\d{2})[._-](20\d{2})/g)]; const last = matches.at(-1); return last ? `${last[3]}-${last[2]}-${last[1]}` : undefined; }
