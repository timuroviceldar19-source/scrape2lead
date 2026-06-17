import { Storage } from "../src/storage/storage.js";
import { exportLeads } from "../src/export/exporter.js";

const s = new Storage("data/scrape2lead-kaspi.db");
const leads = await s.listLeads();
console.log("Total leads:", leads.length);

const result = await exportLeads(leads, "exports");
console.log("CSV:", result.csvPath);
console.log("XLSX:", result.xlsxPath);
s.close();
