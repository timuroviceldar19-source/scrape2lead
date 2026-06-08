import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { buildBatchAuditReport } from "../src/kz/batchAudit.js";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { KzStorage } from "../src/kz/kzStorage.js";

function parseArgs(argv: string[]): { binsFile: string | null; outPath: string | null } {
  let binsFile: string | null = null;
  let outPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      outPath = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (!arg.startsWith("--") && binsFile === null) {
      binsFile = arg;
    }
  }

  return { binsFile, outPath };
}

async function writeAuditWorkbook(report: ReturnType<typeof buildBatchAuditReport>, outPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const workbook = new ExcelJS.Workbook();

  const summarySheet = workbook.addWorksheet("Summary");
  for (const [key, value] of Object.entries(report.summary)) {
    summarySheet.addRow([key, value]);
  }
  summarySheet.addRow(["generated_at", report.generated_at]);

  const companiesSheet = workbook.addWorksheet("Companies");
  companiesSheet.addRow([
    "bin",
    "company_name",
    "normalized_search_name",
    "tender_count",
    "zakup_count",
    "flags",
    "review_priority"
  ]);
  for (const row of report.companies) {
    companiesSheet.addRow([
      row.bin,
      row.company_name,
      row.normalized_search_name,
      row.tender_count,
      row.zakup_count,
      row.flags.join(", "),
      row.review_priority
    ]);
  }

  const tendersSheet = workbook.addWorksheet("TendersReview");
  tendersSheet.addRow([
    "bin",
    "company_name",
    "source",
    "tender_number",
    "tender_name",
    "flags",
    "review_priority",
    "screenshot_path"
  ]);
  for (const row of report.tenders.filter((item) => item.flags.length > 0)) {
    tendersSheet.addRow([
      row.bin,
      row.company_name,
      row.source,
      row.tender_number,
      row.tender_name,
      row.flags.join(", "),
      row.review_priority,
      row.screenshot_path
    ]);
  }

  await workbook.xlsx.writeFile(outPath);
}

async function main(): Promise<void> {
  const { binsFile, outPath } = parseArgs(process.argv.slice(2));
  const bins = binsFile ? readBinsFromCsv(binsFile) : undefined;
  const storage = new KzStorage();

  const companies = storage.getCompanyCards(bins);
  const tenderBins = bins ?? companies.map((company) => company.bin);
  const tenders = storage.getTendersByBins(tenderBins);
  const errors = storage.getEnrichErrors();
  const statFailedBins = errors.filter((error) => error.stage === "stat_gov").map((error) => error.bin);

  const report = buildBatchAuditReport({ companies, tenders, statFailedBins });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const xlsxPath = outPath ?? path.join("exports", `kz-audit-${timestamp}.xlsx`);
  await writeAuditWorkbook(report, xlsxPath);

  console.log("KZ batch audit");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`workbook: ${xlsxPath}`);
  console.log(`manual review: open TendersReview sheet + data/debug/zakup-search-<BIN>.png`);

  storage.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
