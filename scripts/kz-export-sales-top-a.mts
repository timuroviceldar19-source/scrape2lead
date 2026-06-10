import { exportSalesTopAReport } from "../src/kz/salesExporter.js";

const outPath = process.argv[2] ?? "exports/kz-top-a-sales.xlsx";
const batchCsv = process.argv[3] ?? "bins-batch-100.csv";
const topACsv = process.argv[4] ?? "bins-top-a.csv";

const result = await exportSalesTopAReport({
  outPath,
  batchCsv,
  topACsv
});

console.log(`sales export: ${result.xlsxPath}`);
console.log(`companies=${result.companies} registry_phone=${result.withRegistryPhone} gis_phone=${result.with2gisPhone}`);
