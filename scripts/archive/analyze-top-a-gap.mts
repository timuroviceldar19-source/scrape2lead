import Database from "better-sqlite3";
import { readBinsFromCsv } from "../../src/kz/csv.js";
import { scoreCompanyCards } from "../../src/kz/kzLeadScore.js";
import { KzStorage } from "../../src/kz/kzStorage.js";
import { mergeLeadsWithKz } from "../../src/kz/leadKzMerge.js";
import { matchNames } from "../../src/utils/nameNormalizer.js";

const BATCH = process.argv[2] ?? "bins-batch-100.csv";
const TOP_A = process.argv[3] ?? "bins-top-a.csv";
const DB = "data/scrape2lead.db";

const db = new Database(DB);
const storage = new KzStorage({ db });

const batchBins = readBinsFromCsv(BATCH);
const topABins = readBinsFromCsv(TOP_A);
const cards = scoreCompanyCards(storage.getCompanyCards(batchBins));
const topACards = cards.filter((c) => topABins.includes(c.bin));

const { matches } = mergeLeadsWithKz(db, cards);

const matchedByBin = new Map<string, typeof matches>();
for (const m of matches) {
  if (!m.kz_bin || m.match_type === "none") continue;
  const list = matchedByBin.get(m.kz_bin) ?? [];
  list.push(m);
  matchedByBin.set(m.kz_bin, list);
}

const priorityAMatches = matches.filter((m) => m.company_card?.lead_priority === "A");

console.log("=== TOP-A GAP ANALYSIS ===");
console.log(`top-A BINs: ${topABins.length}`);
console.log(`priority-A unified matches (2GIS leads): ${priorityAMatches.length}`);
console.log(`total 2GIS leads in DB: ${db.prepare("SELECT COUNT(*) c FROM leads WHERE source='2gis'").get()?.c}`);
console.log(`2GIS with bin: ${db.prepare("SELECT COUNT(*) c FROM leads WHERE source='2gis' AND bin IS NOT NULL AND TRIM(bin)!=''").get()?.c}`);
console.log("");

const inUnified: typeof topACards = [];
const noLead: typeof topACards = [];
const hasLeadNotA: Array<{ card: (typeof topACards)[0]; matches: typeof matches }> = [];

for (const card of topACards.sort((a, b) => (b.tender_active_budget_sum ?? 0) - (a.tender_active_budget_sum ?? 0))) {
  const leadMatches = matchedByBin.get(card.bin) ?? [];
  const aMatches = leadMatches.filter((m) => m.company_card?.lead_priority === "A");
  if (aMatches.length > 0) {
    inUnified.push(card);
    console.log(`✅ ${card.bin} | ${card.name.slice(0, 50)}`);
    for (const m of aMatches) {
      console.log(`   → 2GIS: ${m.company_name.slice(0, 45)} | ${m.match_type} ${m.match_score.toFixed(2)} | ${m.source}`);
    }
  } else if (leadMatches.length > 0) {
    hasLeadNotA.push({ card, matches: leadMatches });
  } else {
    noLead.push(card);
  }
}

console.log("\n=== NO 2GIS MATCH (23 expected) ===");
for (const card of noLead) {
  const stat = db.prepare("SELECT name FROM stat_gov_data WHERE bin=?").get(card.bin) as { name?: string } | undefined;
  const statName = stat?.name ?? card.name;

  const fuzzyCandidates = db.prepare(`
    SELECT company_name, bin, city FROM leads
    WHERE source='2gis' AND (city LIKE '%стана%' OR city LIKE '%Астана%' OR city LIKE '%лмат%' OR city LIKE '%Almaty%')
    LIMIT 500
  `).all() as Array<{ company_name: string; bin: string | null; city: string }>;

  let best: { name: string; score: number; city: string; bin: string | null } | null = null;
  for (const lead of fuzzyCandidates) {
    const r = matchNames(statName, lead.company_name, 0.5);
    if (r.matched && (!best || r.score > best.score)) {
      best = { name: lead.company_name, score: r.score, city: lead.city, bin: lead.bin };
    }
  }

  console.log(`❌ ${card.bin} | KZ: ${card.name.slice(0, 55)}`);
  console.log(`   tenders: total=${card.tender_count_total} active=${card.tender_count_active} budget=${card.tender_active_budget_sum ?? 0}`);
  if (best) {
    console.log(`   nearest 2GIS: "${best.name.slice(0, 45)}" (${best.city}) score=${best.score.toFixed(2)} bin=${best.bin ?? "—"}`);
  } else {
    console.log(`   nearest 2GIS: none above 0.5`);
  }
}

console.log("\n=== SUMMARY ===");
console.log(`in unified: ${inUnified.length}`);
console.log(`no 2GIS match: ${noLead.length}`);
console.log(`has lead but not priority-A filter: ${hasLeadNotA.length}`);

storage.close();
db.close();
