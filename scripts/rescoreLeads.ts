import Database from "better-sqlite3";
import { calculateConfidenceScore, applyChannelBoost } from "../src/enrichment/scoring.js";

const db = new Database("data/scrape2lead-kaspi.db");

const rows = db.prepare(`
  SELECT 
    lead_id, company_name, city, category,
    enrichment_url,
    phone_status,
    address_status,
    website_status,
    real_website,
    confidence_score, enrichment_status, crm_status
  FROM leads
  WHERE enrichment_status IN ('enriched', 'manual_review', 'not_found')
`).all();

console.log(`Found ${rows.length} leads to rescore\n`);

const updateStmt = db.prepare(`
  UPDATE leads SET
    confidence_score = @confidence_score,
    crm_status = @crm_status,
    enrichment_status = @enrichment_status,
    found_name = @found_name
  WHERE lead_id = @lead_id
`);

const stats = { enriched: 0, manual_review: 0, not_found: 0, unchanged: 0, promoted: 0 };

for (const row of rows) {
  const oldScore = row.confidence_score;
  const oldStatus = row.enrichment_status;

  const phoneStatus = row.phone_status || "empty";
  const addressStatus = row.address_status || "empty";
  const websiteStatus = row.website_status || "empty";
  const hasValidSignal = phoneStatus === "valid" || websiteStatus === "valid";

  const found_name = row.company_name;

  const score = calculateConfidenceScore(
    row.company_name,
    found_name,
    row.city,
    row.city,
    row.category || "",
    row.category || "",
    hasValidSignal,
    row.real_website
  );

  const boost = applyChannelBoost(score.confidence_level, {
    phone: phoneStatus,
    address: addressStatus,
    website: websiteStatus
  });

  let crm_status, enrichment_status;
  if (boost.level === "high") {
    crm_status = "Ready to contact";
    enrichment_status = "enriched";
  } else if (boost.level === "medium") {
    crm_status = "Needs manual review";
    enrichment_status = "manual_review";
  } else {
    crm_status = "Not enough data";
    enrichment_status = "not_found";
  }

  updateStmt.run({
    lead_id: row.lead_id,
    confidence_score: score.total,
    crm_status,
    enrichment_status,
    found_name
  });

  const changed = oldStatus !== enrichment_status;
  if (changed) {
    console.log(`${row.company_name}: ${oldScore?.toFixed(2)} → ${score.total.toFixed(2)} (${oldStatus} → ${enrichment_status})`);
    if (oldStatus === "manual_review" && enrichment_status === "enriched") stats.promoted++;
  }

  if (enrichment_status === "enriched") stats.enriched++;
  else if (enrichment_status === "manual_review") stats.manual_review++;
  else stats.not_found++;
  if (!changed) stats.unchanged++;
}

console.log(`\nResults:`);
console.log(`  enriched: ${stats.enriched}`);
console.log(`  manual_review: ${stats.manual_review}`);
console.log(`  not_found: ${stats.not_found}`);
console.log(`  unchanged: ${stats.unchanged}`);
console.log(`  promoted (manual_review → enriched): ${stats.promoted}`);

db.close();
