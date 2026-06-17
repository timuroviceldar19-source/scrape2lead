import Database from "better-sqlite3";
const db = new Database("data/scrape2lead-kaspi.db");
const cols = db.prepare("PRAGMA table_info(leads)").all();
console.table(cols.map((c: any) => ({ name: c.name, type: c.type })));
db.close();
