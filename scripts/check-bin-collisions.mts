import Database from "better-sqlite3";

const db = new Database("data/scrape2lead.db");
const rows = db.prepare(`
  SELECT company_name, bin, city FROM leads
  WHERE source='2gis' AND bin IS NOT NULL AND TRIM(bin) != ''
`).all() as Array<{ company_name: string; bin: string; city: string }>;

const byBin = new Map<string, typeof rows>();
for (const row of rows) {
  const list = byBin.get(row.bin) ?? [];
  list.push(row);
  byBin.set(row.bin, list);
}

console.log("=== BIN collisions (multiple 2GIS → one BIN) ===");
for (const [bin, leads] of byBin.entries()) {
  if (leads.length <= 1) continue;
  const stat = db.prepare("SELECT name FROM stat_gov_data WHERE bin=?").get(bin) as { name?: string } | undefined;
  console.log(`\n${bin} | KZ: ${(stat?.name ?? "?").slice(0, 60)}`);
  for (const l of leads) console.log(`  2GIS: ${l.company_name} | ${l.city}`);
}

db.close();
