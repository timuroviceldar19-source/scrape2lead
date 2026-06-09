import Database from "better-sqlite3";
import { calculateConfidenceScore, applyChannelBoost } from "../src/enrichment/scoring.js";
import { runMigrations } from "../src/storage/migrations.js";

const db = new Database("data/scrape2lead-kaspi.db");
runMigrations(db);

const beforeStats = {
  enriched: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'enriched'").get() as any).cnt,
  manual_review: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'manual_review'").get() as any).cnt,
  not_found: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'not_found'").get() as any).cnt,
  failed: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'failed'").get() as any).cnt,
  ready_to_contact: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE crm_status = 'Ready to contact'").get() as any).cnt,
};

const rows = db.prepare(`
  SELECT 
    lead_id, company_name, city, category,
    found_name, found_category,
    enrichment_url,
    phone_status,
    address_status,
    website_status,
    real_website,
    confidence_score, enrichment_status, crm_status
  FROM leads
  WHERE enrichment_status IN ('enriched', 'manual_review', 'not_found')
`).all() as any[];

console.log(`=== BEFORE rescore ===`);
console.log(`  enriched:        ${beforeStats.enriched}`);
console.log(`  manual_review:   ${beforeStats.manual_review}`);
console.log(`  not_found:       ${beforeStats.not_found}`);
console.log(`  failed:          ${beforeStats.failed}`);
console.log(`  Ready to contact:${beforeStats.ready_to_contact}`);
console.log(`\nRescoring ${rows.length} leads...\n`);

const updateStmt = db.prepare(`
  UPDATE leads SET
    confidence_score = @confidence_score,
    crm_status = @crm_status,
    enrichment_status = @enrichment_status
  WHERE lead_id = @lead_id
`);

const stats = { enriched: 0, manual_review: 0, not_found: 0, unchanged: 0, changed: 0, downgraded: 0, promoted: 0 };
const changes: string[] = [];

for (const row of rows) {
  const oldScore = row.confidence_score;
  const oldStatus = row.enrichment_status;

  const phoneStatus = row.phone_status || "empty";
  const addressStatus = row.address_status || "empty";
  const websiteStatus = row.website_status || "empty";

  const foundName = row.found_name || row.company_name;
  const foundCategory = row.found_category || row.category || "";

  const score = calculateConfidenceScore(
    row.company_name,
    foundName,
    row.city,
    row.city,
    row.category || "",
    foundCategory,
    phoneStatus === "valid",
    addressStatus === "valid",
    websiteStatus === "valid",
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
    enrichment_status
  });

  const changed = oldStatus !== enrichment_status;
  if (changed) {
    stats.changed++;
    const change = `${row.company_name}: ${oldScore?.toFixed(2)} -> ${score.total.toFixed(2)} (${oldStatus} -> ${enrichment_status})`;
    changes.push(change);
    if (oldStatus === "enriched" && enrichment_status !== "enriched") stats.downgraded++;
    if (oldStatus === "manual_review" && enrichment_status === "enriched") stats.promoted++;
    if (oldStatus === "not_found" && enrichment_status !== "not_found") stats.promoted++;
  } else {
    stats.unchanged++;
  }

  if (enrichment_status === "enriched") stats.enriched++;
  else if (enrichment_status === "manual_review") stats.manual_review++;
  else stats.not_found++;
}

if (changes.length > 0) {
  console.log("Changes:");
  changes.forEach(c => console.log(`  ${c}`));
}

const afterStats = {
  enriched: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'enriched'").get() as any).cnt,
  manual_review: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'manual_review'").get() as any).cnt,
  not_found: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'not_found'").get() as any).cnt,
  failed: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE enrichment_status = 'failed'").get() as any).cnt,
  ready_to_contact: (db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE crm_status = 'Ready to contact'").get() as any).cnt,
};

console.log(`\n=== AFTER rescore ===`);
console.log(`  enriched:        ${afterStats.enriched}`);
console.log(`  manual_review:   ${afterStats.manual_review}`);
console.log(`  not_found:       ${afterStats.not_found}`);
console.log(`  failed:          ${afterStats.failed}`);
console.log(`  Ready to contact:${afterStats.ready_to_contact}`);

console.log(`\n=== Delta ===`);
console.log(`  enriched:        ${beforeStats.enriched} -> ${afterStats.enriched} (${afterStats.enriched - beforeStats.enriched >= 0 ? "+" : ""}${afterStats.enriched - beforeStats.enriched})`);
console.log(`  manual_review:   ${beforeStats.manual_review} -> ${afterStats.manual_review} (${afterStats.manual_review - beforeStats.manual_review >= 0 ? "+" : ""}${afterStats.manual_review - beforeStats.manual_review})`);
console.log(`  not_found:       ${beforeStats.not_found} -> ${afterStats.not_found} (${afterStats.not_found - beforeStats.not_found >= 0 ? "+" : ""}${afterStats.not_found - beforeStats.not_found})`);
console.log(`  Ready to contact:${beforeStats.ready_to_contact} -> ${afterStats.ready_to_contact} (${afterStats.ready_to_contact - beforeStats.ready_to_contact >= 0 ? "+" : ""}${afterStats.ready_to_contact - beforeStats.ready_to_contact})`);
console.log(`  unchanged: ${stats.unchanged}, changed: ${stats.changed}, downgraded: ${stats.downgraded}, promoted: ${stats.promoted}`);

db.close();
