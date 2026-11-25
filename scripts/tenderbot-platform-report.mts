/**
 * Отчёт по выгрузке Tenderbot: что из неё мы и так собираем, а что — реальный пробел.
 *
 *   npx tsx scripts/tenderbot-platform-report.mts --in outputs/tenderbot-ids-gz-computers/lots.json
 *
 * Пишет report.md, report-gap.csv и report.json рядом с выгрузкой. В пробел попадают
 * только непокрытые площадки (Omarket, ЭТБ, EurasianTech) и только наши товары.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildPlatformReport,
  isProduct,
  renderMarkdown,
  type PlatformReport
} from "../src/kz/tenderbotPlatformReport.js";

function parseArgs(argv: string[]): { input: string | undefined; outDir: string | undefined } {
  const args: { input: string | undefined; outDir: string | undefined } = { input: undefined, outDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") args.input = argv[++i];
    else if (argv[i] === "--out") args.outDir = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("См. шапку скрипта");
      process.exit(0);
    }
  }
  return args;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Укажите --in путь к lots.json из scripts/tenderbot-export-ids.mts");
    process.exit(1);
  }
  const inputPath = path.resolve(args.input);
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
    lots?: Array<{ id: number; name?: string; amount?: number; customer?: string; goszakupLink?: string; keyword?: string }>;
  };
  if (!Array.isArray(payload.lots) || payload.lots.length === 0) {
    console.error("В файле нет массива lots");
    process.exit(1);
  }

  const report: PlatformReport = buildPlatformReport(payload.lots);
  const outDir = args.outDir ?? path.dirname(inputPath);
  fs.mkdirSync(outDir, { recursive: true });

  const mdPath = path.join(outDir, "report.md");
  const csvPath = path.join(outDir, "report-gap.csv");
  const jsonPath = path.join(outDir, "report.json");
  fs.writeFileSync(mdPath, renderMarkdown(report), "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1), "utf8");

  const gapRows = report.rows.filter((row) => row.platformGroup === "gap" && isProduct(row.productKind));
  const header = "id;name;amount;platform;link;customer;keyword";
  fs.writeFileSync(
    csvPath,
    `\uFEFF${header}\r\n` + gapRows.map((row) => [row.id, row.name, row.amount, row.platform, row.link, row.customer, row.keyword].map(csvCell).join(";")).join("\r\n") + "\r\n",
    "utf8"
  );

  console.log(`Всего строк: ${report.totalLots}`);
  for (const group of report.groups) {
    console.log(`  ${group.group}: ${group.lots} (наших ${group.productLots})`);
  }
  console.log(`Реальный пробел: ${report.gapLots} лотов на ${(report.gapSum / 1_000_000).toFixed(1)} млн ₸`);
  console.log(`Файлы:\n  ${mdPath}\n  ${csvPath}\n  ${jsonPath}`);
}

main();
