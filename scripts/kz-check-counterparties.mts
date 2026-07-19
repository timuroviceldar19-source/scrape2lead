import crypto from "node:crypto";
import path from "node:path";
import { parseCounterpartyArgs, readCounterpartyBins } from "../src/kz/kgdCounterpartyInput.js";
import { createBulkChecker, loadBulkSources } from "../src/kz/kgdBulkProvider.js";
import { KgdInteractiveClient } from "../src/kz/kgdInteractiveClient.js";
import { runCounterpartyChecks } from "../src/kz/kgdCounterpartyWorkflow.js";
import { verifyPdfWithPoppler, writeCounterpartyExcel, writeCounterpartyPdf } from "../src/kz/kgdReport.js";

async function main(): Promise<void> {
  const args = parseCounterpartyArgs(process.argv.slice(2)); const input = await readCounterpartyBins(args.input, args.limit);
  console.log(`Вход: строк=${input.totalRows}, валидных уникальных к обработке=${input.bins.length}, невалидных=${input.invalidRows}, дублей=${input.duplicateRows}, пропущено лимитом=${input.limitSkipped}`);
  const sources = await loadBulkSources("data/kgd-cache"); const bulk = createBulkChecker(sources); const interactive = new KgdInteractiveClient(10 * 60_000, console.log);
  const progressKey = crypto.createHash("sha256").update(path.resolve(args.input)).digest("hex").slice(0, 12); const progressPath = path.join("data", "kgd-progress", `${progressKey}.json`);
  try {
    const results = await runCounterpartyChecks(input.bins, { progressPath, checkCounterparty: (bin) => interactive.checkCounterparty(bin), checkLiquidation: (bin) => interactive.checkLiquidation(bin), checkBulk: bulk, onProgress: console.log });
    const date = new Date().toISOString().slice(0, 10); const xlsx = path.join("exports", `kgd-counterparty-report-${date}.xlsx`); const pdf = path.join("output", "pdf", `kgd-counterparty-report-${date}.pdf`);
    await writeCounterpartyExcel(results, xlsx); await writeCounterpartyPdf(results, pdf); const popplerVerified = await verifyPdfWithPoppler(pdf);
    const counts = Object.fromEntries(["red", "gray", "yellow", "green"].map((color) => [color, results.filter((r) => r.color === color).length]));
    console.log(`Готово: ${xlsx}`); console.log(`Готово: ${pdf}`); console.log(`Статистика: ${JSON.stringify(counts)}`);
    if (!popplerVerified) console.warn("Poppler (pdftoppm) не найден: автоматический рендер PDF в PNG пропущен");
  } finally { await interactive.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
