import { Storage } from "../../src/storage/storage.js";

const storage = new Storage("data/scrape2lead.db");

storage.db.prepare(`
  UPDATE leads SET lead_id = 'SEED-ALMATY-1' WHERE external_id = 'seed-almaty-1' AND lead_id IS NULL
`).run();

storage.db.prepare(`
  UPDATE leads SET lead_id = 'SEED-ALMATY-2' WHERE external_id = 'seed-almaty-2' AND lead_id IS NULL
`).run();

storage.db.prepare(`
  UPDATE leads SET lead_id = 'SEED-ALMATY-3' WHERE external_id = 'seed-almaty-3' AND lead_id IS NULL
`).run();

console.log("lead_id updated for seed leads.");

const rows = storage.db.prepare(`
  SELECT external_id, lead_id, company_name, crm_status 
  FROM leads 
  WHERE external_id LIKE 'seed-almaty-%'
`).all();

console.log(JSON.stringify(rows, null, 2));
storage.close();
