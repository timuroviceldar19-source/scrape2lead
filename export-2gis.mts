import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { exportLeads } from "./src/export/exporter.js";
import type { Lead } from "./src/types.js";
import { Storage } from "./src/storage/storage.js";

const dbPath = "data/scrape2lead-2gis.db";
const exportDir = "exports";

const storage = new Storage(dbPath);

const allRows = storage.db
  .prepare(
    "SELECT * FROM leads ORDER BY lead_score DESC, crm_status, company_name"
  )
  .all() as Array<Record<string, unknown>>;

const leads: Lead[] = allRows.map((row) => storage["mapRowToLead"](row));

console.log(`Exporting ${leads.length} leads from ${dbPath} to ${exportDir}/`);

const byCrm = new Map<string, number>();
for (const lead of leads) {
  const k = lead.crm_status ?? "(null)";
  byCrm.set(k, (byCrm.get(k) ?? 0) + 1);
}
console.log("By crm_status:", Object.fromEntries(byCrm));

fs.mkdirSync(exportDir, { recursive: true });
const result = await exportLeads(leads, exportDir);
console.log("CSV:", result.csvPath);
console.log("XLSX:", result.xlsxPath);
console.log("Sizes:", {
  csv: fs.statSync(result.csvPath).size,
  xlsx: fs.statSync(result.xlsxPath).size
});

storage.close();
