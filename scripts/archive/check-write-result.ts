import { Storage } from "../src/storage/storage.js";

const storage = new Storage("data/scrape2lead.db");
const rows = storage.db.prepare(`
  SELECT external_id, company_name, crm_status, enrichment_status, enrichment_error, enrichment_attempted_at
  FROM leads 
  WHERE external_id IN ('seed-almaty-1', 'seed-almaty-2', 'seed-almaty-3')
`).all();

console.log("Updated leads in DB:");
console.log(JSON.stringify(rows, null, 2));
storage.close();
