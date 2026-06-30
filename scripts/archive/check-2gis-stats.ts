import Database from "better-sqlite3";

const db = new Database("data/scrape2lead-2gis.db");

const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN json_array_length(phones) > 0 THEN 1 ELSE 0 END) as with_phone,
    SUM(CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) as with_website,
    SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as with_email,
    SUM(CASE WHEN address IS NOT NULL AND address != '' THEN 1 ELSE 0 END) as with_address,
    SUM(CASE WHEN messenger_links IS NOT NULL AND messenger_links != '[]' AND messenger_links != '' THEN 1 ELSE 0 END) as with_messengers,
    SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) as with_rating
  FROM leads
  WHERE source = '2gis'
`).get();

console.log("Текущее состояние 2GIS лидов:");
console.log(JSON.stringify(stats, null, 2));

db.close();
