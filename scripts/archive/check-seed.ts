import { Storage } from "../../src/storage/storage.js";

const storage = new Storage("data/scrape2lead.db");
const rows = storage.db.prepare(`
  SELECT external_id, company_name, crm_status, phone_status, website_status 
  FROM leads 
  WHERE city = 'Алматы' AND crm_status = 'Needs enrichment'
`).all();

console.log("Seed leads found:", rows.length);
console.log(JSON.stringify(rows, null, 2));
storage.close();
