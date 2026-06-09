import Database from "better-sqlite3";
import { isValidBin } from "./csv.js";
import { runKzEnrich } from "./enrichPipeline.js";
import { scoreCompanyCards } from "./kzLeadScore.js";
import { KzStorage } from "./kzStorage.js";
import { mergeLeadsWithKz, writeKzToLeads } from "./leadKzMerge.js";
import { mergeStatGovData } from "../../scripts/merge-stat-gov-data.js";

export interface EnrichMissingOptions {
  databasePath?: string;
  /** Scope company cards when resolving fuzzy lead → KZ BIN matches */
  cardBins?: string[];
  skipZakup?: boolean;
  skipGoszakupHtml?: boolean;
}

export interface EnrichMissingResult {
  leadBins: number;
  missingBins: string[];
  enrichedBins: number;
  mergeStatMatched: number;
  writeKzToLeads: number;
}

export function collectLeadBins(db: Database.Database, matchedBins: string[] = []): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT bin FROM leads
    WHERE bin IS NOT NULL AND TRIM(bin) != ''
  `).all() as Array<{ bin: string }>;

  const bins = new Set<string>();
  for (const row of rows) {
    const bin = row.bin.trim();
    if (isValidBin(bin)) bins.add(bin);
  }
  for (const bin of matchedBins) {
    const trimmed = bin.trim();
    if (isValidBin(trimmed)) bins.add(trimmed);
  }
  return Array.from(bins);
}

export function findBinsMissingEnrich(storage: KzStorage, bins: string[]): string[] {
  return bins.filter((bin) => {
    const hasStat = storage.getStatGovByBin(bin) !== null;
    const hasRegistry = storage.getGoszakupRegistryByBin(bin) !== null;
    const hasTenders = storage.getTendersByBins([bin]).length > 0;
    return !hasStat || !hasRegistry || !hasTenders;
  });
}

export async function enrichMissingLeadBins(options: EnrichMissingOptions = {}): Promise<EnrichMissingResult> {
  const dbPath = options.databasePath ?? "data/scrape2lead.db";
  const db = new Database(dbPath);
  const storage = new KzStorage({ db });

  try {
    const cards = scoreCompanyCards(storage.getCompanyCards(options.cardBins));
    const { matches } = mergeLeadsWithKz(db, cards);
    const matchedBins = matches.map((match) => match.kz_bin).filter(Boolean) as string[];
    const leadBins = collectLeadBins(db, matchedBins);
    const missingBins = findBinsMissingEnrich(storage, leadBins);

    if (missingBins.length === 0) {
      return {
        leadBins: leadBins.length,
        missingBins,
        enrichedBins: 0,
        mergeStatMatched: 0,
        writeKzToLeads: 0
      };
    }

    console.log(`enrich-missing: ${missingBins.length}/${leadBins.length} BINs need KZ data`);
    await runKzEnrich({
      bins: missingBins,
      databasePath: dbPath,
      skipZakup: options.skipZakup ?? true,
      skipGoszakupHtml: options.skipGoszakupHtml ?? false
    });

    const mergeStat = mergeStatGovData(db);
    const { matches: refreshedMatches } = mergeLeadsWithKz(db, cards);
    const kzWritten = writeKzToLeads(db, refreshedMatches);

    return {
      leadBins: leadBins.length,
      missingBins,
      enrichedBins: missingBins.length,
      mergeStatMatched: mergeStat.matched,
      writeKzToLeads: kzWritten
    };
  } finally {
    storage.close();
    db.close();
  }
}
