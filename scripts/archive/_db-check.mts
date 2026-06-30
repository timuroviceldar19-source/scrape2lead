import Database from "better-sqlite3";

for (const path of ["data/scrape2lead.db", "data/scrape2lead-kz.db"]) {
  try {
    const db = new Database(path, { readonly: true });
    const leads = (db.prepare("SELECT COUNT(*) AS c FROM leads").get() as { c: number }).c;
    const stat = (db.prepare("SELECT COUNT(*) AS c FROM stat_gov_data").get() as { c: number }).c;
    const tenders = (db.prepare("SELECT COUNT(*) AS c FROM tender_data").get() as { c: number }).c;
    console.log(path, { leads, stat, tenders });
    db.close();
  } catch (e) {
    console.log(path, "missing or error");
  }
}
