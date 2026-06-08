import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

const input = process.argv[2] ?? "exports/kz-batch-100-scored.xlsx";
const output = process.argv[3] ?? "exports/kz-top-a-leads.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(input);

const companies = wb.getWorksheet("Companies");
const tenders = wb.getWorksheet("Tenders");
if (!companies || !tenders) {
  throw new Error("Expected Companies and Tenders sheets");
}

const headers = companies.getRow(1).values as unknown[];
const colIndex = (name: string): number => {
  const idx = headers.findIndex((h) => h === name);
  if (idx < 0) throw new Error(`Column not found: ${name}`);
  return idx;
};

const priorityCol = colIndex("Приоритет лида");
const activeBudgetCol = colIndex("Сумма активных");
const activeCountCol = colIndex("Активные закупки");
const binCol = colIndex("БИН");

const topA: Array<{ row: ExcelJS.Row; activeBudget: number; activeCount: number }> = [];
for (let r = 2; r <= companies.rowCount; r++) {
  const row = companies.getRow(r);
  if (String(row.getCell(priorityCol).value ?? "") !== "A") continue;
  topA.push({
    row,
    activeBudget: Number(row.getCell(activeBudgetCol).value ?? 0),
    activeCount: Number(row.getCell(activeCountCol).value ?? 0)
  });
}

topA.sort((a, b) => b.activeBudget - a.activeBudget || b.activeCount - a.activeCount);

const topBins = new Set<string>();
const outWb = new ExcelJS.Workbook();
outWb.creator = "Scrape2Lead";

const outCompanies = outWb.addWorksheet("Companies");
outCompanies.columns = companies.columns.map((col) => ({
  header: String(col.header ?? ""),
  key: String(col.key ?? col.header ?? ""),
  width: col.width ?? 16
}));

for (const item of topA) {
  const values = item.row.values as unknown[];
  outCompanies.addRow(values.slice(1));
  topBins.add(String(item.row.getCell(binCol).value ?? ""));
}

const outTenders = outWb.addWorksheet("Tenders");
outTenders.columns = tenders.columns.map((col) => ({
  header: String(col.header ?? ""),
  key: String(col.key ?? col.header ?? ""),
  width: col.width ?? 16
}));

const tenderBinCol = (tenders.getRow(1).values as unknown[]).findIndex((h) => h === "БИН");
let tenderRows = 0;
for (let r = 2; r <= tenders.rowCount; r++) {
  const row = tenders.getRow(r);
  const bin = String(row.getCell(tenderBinCol).value ?? "");
  if (!topBins.has(bin)) continue;
  outTenders.addRow((row.values as unknown[]).slice(1));
  tenderRows++;
}

const summary = outWb.addWorksheet("Summary");
summary.addRows([
  { metric: "Источник", value: input },
  { metric: "Компаний приоритет A", value: topA.length },
  { metric: "Контрактов (Tenders)", value: tenderRows },
  { metric: "Сумма активных (top-A)", value: topA.reduce((s, x) => s + x.activeBudget, 0) }
]);

fs.mkdirSync(path.dirname(output), { recursive: true });
await outWb.xlsx.writeFile(output);

console.log(`top-A export: ${output}`);
console.log(`companies=${topA.length} tenders=${tenderRows}`);
