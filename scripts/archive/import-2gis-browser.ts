import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Storage } from "../../src/storage/storage.js";
import { finalizeLead } from "../../src/normalizer/normalize.js";
import type { Lead } from "../../src/types.js";

const DB_PATH = "data/scrape2lead-2gis.db";
const INPUT_FILE = "2gis-contacts.json";

interface BrowserFirm {
  id: string;
  name: string;
  legal_name?: string;
  address: string;
  city: string;
  district?: string;
  point?: { lat: number; lon: number } | null;
  rubrics: string[];
  rating?: number | null;
  review_count?: number | null;
  schedule?: unknown;
  contacts: Array<{ type: string; value: string }>;
  phones: string[];
  website: string;
  whatsapp: string;
  telegram: string;
  email: string[];
  error?: string;
}

function scoreLead(lead: Lead): { score: number; priority: "A" | "B" | "C" | "D" } {
  let score = 0;
  if (lead.phones.length > 0) score += 40;
  if (lead.website) score += 15;
  if (lead.email) score += 10;
  if (lead.messenger_links.length > 0) score += 15;
  if (lead.address) score += 10;
  if (lead.rating && lead.rating >= 4.0) score += 10;
  if (lead.review_count && lead.review_count >= 10) score += 5;

  let priority: "A" | "B" | "C" | "D";
  if (score >= 70) priority = "A";
  else if (score >= 50) priority = "B";
  else if (score >= 30) priority = "C";
  else priority = "D";

  return { score, priority };
}

function mapBrowserFirmToLead(firm: BrowserFirm, category: string): Lead {
  const messengers: string[] = [];
  if (firm.whatsapp) messengers.push("WhatsApp");
  if (firm.telegram) messengers.push("Telegram");

  const lead: Lead = finalizeLead({
    source: "2gis",
    external_id: firm.id,
    company_name: firm.name,
    category: firm.rubrics[0] || category,
    city: firm.city || "Астана",
    address: firm.address,
    phones: firm.phones,
    email: firm.email[0] || null,
    website: firm.website || null,
    social_links: [],
    messenger_links: messengers,
    parsed_at: new Date().toISOString(),
    incomplete: false,
    rating: firm.rating ?? undefined,
    review_count: firm.review_count ?? undefined,
    shop_categories: firm.rubrics,
    source_search_city: firm.city || "Астана",
    merchant_city_guess: firm.city || "Астана",
    city_status: "ok",
    address_raw: firm.address,
    address_clean: firm.address,
    address_status: firm.address ? "valid" : "empty",
    phone_raw: firm.phones[0] || "",
    phone_normalized: firm.phones[0] || "",
    phone_status: firm.phones.length > 0 ? "valid" : "empty",
    email_raw: firm.email[0] || "",
    email_status: firm.email.length > 0 ? "valid" : "empty",
    real_website: firm.website || "",
    website_status: firm.website ? "valid" : "empty",
    messenger_flags: messengers.join(","),
    enrichment_status: "enriched",
    enrichment_source: "2gis",
    found_name: firm.name,
    found_category: firm.rubrics[0] || category,
  });

  const { score, priority } = scoreLead(lead);
  lead.lead_score = score;
  lead.priority = priority;
  lead.contactability = firm.phones.length > 0 ? "Phone ready" : "No usable contact";
  lead.crm_status = firm.phones.length > 0 ? "Ready to call" : "Needs enrichment";
  lead.next_action = firm.phones.length > 0 ? "Call" : "Find phone";
  lead.parser_note = `Browser API import ${new Date().toISOString().slice(0, 10)}`;

  return lead;
}

async function main() {
  const args = process.argv.slice(2);
  const inputFile = args[0] || INPUT_FILE;
  const dbPath = args[1] || DB_PATH;
  const category = args[2] || "Автосервис";

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    console.error("Usage: npx tsx scripts/import-2gis-browser.ts [input.json] [db.sqlite] [category]");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  const firms: BrowserFirm[] = Array.isArray(raw) ? raw : raw.results || [];

  if (firms.length === 0) {
    console.error("No firms found in input file");
    process.exit(1);
  }

  const valid = firms.filter(f => !f.error);
  const errored = firms.filter(f => f.error);
  console.log(`Input: ${valid.length} valid firms, ${errored.length} errors`);

  const storage = new Storage(dbPath);
  let imported = 0;
  let skipped = 0;

  for (const firm of valid) {
    const lead = mapBrowserFirmToLead(firm, category);
    try {
      await storage.upsertLead(lead);
      imported++;
      const phones = lead.phones.join(", ");
      console.log(`  [${imported}] ${lead.company_name} | ${phones} | score=${lead.lead_score} ${lead.priority}`);
    } catch (e: any) {
      skipped++;
      console.error(`  SKIP ${firm.id}: ${e.message}`);
    }
  }

  console.log(`\nImported: ${imported}, Skipped: ${skipped}`);
  console.log(`Database: ${dbPath}`);

  const allLeads = (await storage.listLeads()).filter(l => l.source === "2gis");
  const byPriority = { A: 0, B: 0, C: 0, D: 0 };
  const byStatus = new Map<string, number>();
  for (const l of allLeads) {
    if (l.priority) byPriority[l.priority as keyof typeof byPriority]++;
    const s = l.crm_status || "unknown";
    byStatus.set(s, (byStatus.get(s) || 0) + 1);
  }
  console.log(`\nTotal 2GIS leads in DB: ${allLeads.length}`);
  console.log("By priority:", byPriority);
  console.log("By CRM status:", Object.fromEntries(byStatus));
}

main().catch(e => { console.error(e); process.exit(1); });
