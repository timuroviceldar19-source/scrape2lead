import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ExcelJS from "exceljs";
import type { CounterpartyCheck, RiskColor } from "./kgdCounterpartyTypes.js";

const COLORS: Record<RiskColor, string> = { red: "FFFFC7CE", gray: "FFD9E1F2", yellow: "FFFFEB9C", green: "FFC6EFCE" };
const COLUMNS = [
  ["БИН", "bin", 16], ["Наименование", "name", 34], ["Цвет", "color", 12], ["НДС", "vat", 22], ["Дата постановки НДС", "vatStart", 18], ["Дата снятия НДС", "vatEnd", 18],
  ["Банкротство", "bankruptcy", 14], ["Ликвидация", "liquidation", 14], ["Дата ликвидации", "liquidationDate", 18], ["Ограничение ЭСФ", "esf", 17],
  ["Неблагонадёжность", "unreliable", 19], ["Причины неблагонадёжности", "unreliableReasons", 38], ["Bulk-совпадения", "bulkMatches", 42], ["Даты списков", "listDates", 26],
  ["Свежесть источников", "freshness", 30], ["Пояснения", "explanations", 70], ["Время проверки", "checkedAt", 24], ["Ссылки", "links", 55]
] as const;

export async function writeCounterpartyExcel(results: CounterpartyCheck[], target: string): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true }); const book = new ExcelJS.Workbook(); book.creator = "Scrape2Lead"; const sheet = book.addWorksheet("Риски контрагентов", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = COLUMNS.map(([header, key, width]) => ({ header, key, width }));
  for (const result of results) { const row = sheet.addRow(toExcelRow(result)); row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS[result.color ?? "gray"] } }; row.alignment = { vertical: "top", wrapText: true }; }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } }; sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(COLUMNS.length).letter}1` };
  await book.xlsx.writeFile(target);
}

export async function writeCounterpartyPdf(results: CounterpartyCheck[], target: string): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true }); const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kgd-pdf-")); const json = path.join(tempDir, "report.json"); fs.writeFileSync(json, JSON.stringify(results));
  try { await run("python", [path.join(process.cwd(), "scripts", "kgd-counterparty-pdf.py"), json, target]); } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

export async function verifyPdfWithPoppler(target: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kgd-poppler-"));
  try { await run("pdftoppm", ["-png", "-r", "110", target, path.join(dir, "page")]); const pages = fs.readdirSync(dir).filter((name) => name.endsWith(".png")); return pages.length > 0 && pages.every((name) => fs.statSync(path.join(dir, name)).size > 1000); }
  catch (error) { if (/ENOENT|not recognized|not found/i.test(String(error))) return false; throw error; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function toExcelRow(r: CounterpartyCheck): Record<string, unknown> { const matches = r.bulkChecks.flatMap((b) => b.matches ?? []); return { bin: r.bin, name: r.name, color: r.color, vat: r.vat.status, vatStart: r.vat.registeredAt ?? "", vatEnd: r.vat.removedAt ?? "", bankruptcy: yes(r.bankruptcy), liquidation: yes(r.liquidation.active), liquidationDate: r.liquidation.startDate ?? "", esf: yes(r.esfRestricted), unreliable: yes(r.unreliable), unreliableReasons: r.unreliableReasons.join("; "), bulkMatches: matches.map((m) => `${m.listType}: ${m.name}`).join("; "), listDates: r.bulkChecks.map((b) => `${b.source}: ${b.listDate ?? "н/д"}`).join("; "), freshness: r.bulkChecks.map((b) => `${b.source}: ${b.status}${b.cacheAgeHours === undefined ? "" : ` (${b.cacheAgeHours.toFixed(1)} ч)`}`).join("; "), explanations: (r.explanations ?? []).join("; "), checkedAt: r.checkedAt, links: [...r.links, ...r.bulkChecks.map((b) => b.sourceUrl)].filter(Boolean).join("; ") }; }
function yes(value: boolean): string { return value ? "Да" : "Нет"; }
function run(command: string, args: string[]): Promise<void> { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", (data) => stderr += data); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ReportLab PDF failed (${code}): ${stderr}`))); }); }
