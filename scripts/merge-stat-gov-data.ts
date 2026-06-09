import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";
import { matchNames } from "../src/utils/nameNormalizer.js";

export interface MergeStatGovStats {
  matched: number;
  skipped: number;
}

interface StatGovData {
  bin: string;
  name: string;
  registration_date: string | null;
  oked: string | null;
  oked_name: string | null;
  director: string | null;
  legal_status: string | null;
  kfs_name: string | null;
}

interface Lead {
  source: string;
  external_id: string;
  company_name: string;
  bin: string | null;
}

export function mergeStatGovData(db: Database.Database): MergeStatGovStats {
  const statData = db.prepare("SELECT * FROM stat_gov_data").all() as StatGovData[];
  const leads = db.prepare("SELECT source, external_id, company_name, bin FROM leads").all() as Lead[];
  const updateStmt = db.prepare(`
    UPDATE leads SET
      bin = ?,
      registration_date = ?,
      oked = ?,
      oked_name = ?,
      director = ?,
      founder = NULL,
      legal_status = ?,
      company_age_years = ?,
      legal_form = ?
    WHERE source = ? AND external_id = ?
  `);

  let matched = 0;
  let skipped = 0;

  for (const stat of statData) {
    const bestMatch = findBestLeadMatch(stat, leads);
    if (!bestMatch) {
      skipped++;
      continue;
    }

    updateStmt.run(
      stat.bin,
      stat.registration_date,
      stat.oked,
      stat.oked_name,
      stat.director,
      stat.legal_status,
      calculateCompanyAgeYears(stat.registration_date),
      stat.kfs_name || parseLegalFormFromName(stat.name),
      bestMatch.source,
      bestMatch.external_id
    );
    matched++;
  }

  return { matched, skipped };
}

function findBestLeadMatch(stat: StatGovData, leads: Lead[]): Lead | null {
  let bestMatch: Lead | null = null;
  let bestScore = 0;

  for (const lead of leads) {
    if (lead.bin === stat.bin) return lead;

    const result = matchNames(stat.name, lead.company_name, 0.7);
    if (result.matched && result.score > bestScore) {
      bestScore = result.score;
      bestMatch = lead;
    }
  }

  return bestMatch;
}

export function calculateCompanyAgeYears(registrationDate: string | null): number | null {
  const parsed = parseRegistrationDate(registrationDate);
  if (!parsed) return null;
  return Math.floor((Date.now() - parsed.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

function parseRegistrationDate(value: string | null): Date | null {
  if (!value) return null;
  const ddmmyyyy = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}T00:00:00.000Z`);

  const iso = value.match(/^\d{4}-\d{2}-\d{2}$/);
  if (iso) return new Date(`${value}T00:00:00.000Z`);
  return null;
}

function parseLegalFormFromName(name: string): string | null {
  const upper = name.toUpperCase();
  if (upper.includes("ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ") || /\bТОО\b/u.test(upper)) return "ТОО";
  if (upper.includes("АКЦИОНЕРНОЕ ОБЩЕСТВО") || /\bАО\b/u.test(upper)) return "АО";
  if (upper.includes("ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ") || /\bИП\b/u.test(upper)) return "ИП";
  return null;
}

function main(): void {
  const db = new Database("data/scrape2lead.db");
  try {
    const stats = mergeStatGovData(db);
    console.log(`merge stat.gov: matched=${stats.matched} skipped=${stats.skipped}`);
  } finally {
    db.close();
  }
}

const thisFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (thisFile === invokedFile) {
  main();
}
