import Database from "better-sqlite3";
import { matchNames } from "../utils/nameNormalizer.js";
import type { CompanyCard, StatGovRecord } from "./tenderTypes.js";
import type { GoszakupRegistryRecord } from "./registryTypes.js";
import type { ScoredCompanyCard } from "./kzLeadScore.js";

export interface LeadContactFields {
  address?: string | null;
  address_clean?: string | null;
  address_raw?: string | null;
  phones?: string | null;
  phone_normalized?: string | null;
  phone_raw?: string | null;
  crm_status?: string | null;
  lead_score?: number | null;
  registration_date?: string | null;
  company_age_years?: number | null;
}

export interface LeadKzMatch extends LeadContactFields {
  source: string;
  external_id: string;
  company_name: string;
  bin: string | null;
  kz_bin: string | null;
  match_type: "exact_bin" | "fuzzy_name_stat" | "fuzzy_name_registry" | "none";
  match_score: number;
  stat_gov: StatGovRecord | null;
  registry: GoszakupRegistryRecord | null;
  company_card: ScoredCompanyCard | null;
}

export interface LeadKzMergeStats {
  total_leads: number;
  with_bin: number;
  matched_exact: number;
  matched_fuzzy_stat: number;
  matched_fuzzy_registry: number;
  unmatched: number;
  with_tenders: number;
}

interface LeadRow extends LeadContactFields {
  source: string;
  external_id: string;
  company_name: string;
  bin: string | null;
}

const LEAD_SELECT = `
  SELECT
    source, external_id, company_name, bin,
    address, address_clean, address_raw,
    phones, phone_normalized, phone_raw,
    crm_status, lead_score, registration_date, company_age_years
  FROM leads
`;

export function formatLeadPhone(lead: LeadContactFields): string {
  const normalized = lead.phone_normalized?.trim();
  if (normalized) return normalized;

  const fromJson = parseLeadPhones(lead.phones);
  if (fromJson.length > 0) return fromJson.join(", ");

  return lead.phone_raw?.trim() ?? "";
}

export function formatLeadAddress(lead: LeadContactFields): string {
  return lead.address_clean?.trim() || lead.address?.trim() || lead.address_raw?.trim() || "";
}

function parseLeadPhones(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((value) => value.trim()).filter(Boolean);
    }
  } catch {
    // fall through
  }
  return [];
}

const FUZZY_THRESHOLD = 0.7;
const BACKFILL_THRESHOLD = 0.75;

interface BackfillLeadRow {
  source: string;
  external_id: string;
  company_name: string;
  bin: string | null;
}

interface BackfillCandidate {
  source: string;
  external_id: string;
  company_name: string;
  bin: string;
  score: number;
  cardPriority: number;
}

function priorityRank(priority: string): number {
  if (priority === "A") return 0;
  if (priority === "B") return 1;
  if (priority === "C") return 2;
  return 3;
}

function sortCardsForBackfill(cards: ScoredCompanyCard[]): ScoredCompanyCard[] {
  return [...cards].sort((a, b) => {
    const byPriority = priorityRank(a.lead_priority) - priorityRank(b.lead_priority);
    if (byPriority !== 0) return byPriority;
    return (b.tender_active_budget_sum ?? 0) - (a.tender_active_budget_sum ?? 0);
  });
}

function scopedStatEntries(
  cardsByBin: Map<string, ScoredCompanyCard>,
  statByBin: Map<string, StatGovRecord>
): Array<[string, StatGovRecord]> {
  if (cardsByBin.size === 0) return Array.from(statByBin.entries());
  const rows: Array<[string, StatGovRecord]> = [];
  for (const bin of cardsByBin.keys()) {
    const stat = statByBin.get(bin);
    if (stat) rows.push([bin, stat]);
  }
  return rows;
}

function scopedRegistryEntries(
  cardsByBin: Map<string, ScoredCompanyCard>,
  registryByBin: Map<string, GoszakupRegistryRecord>
): Array<[string, GoszakupRegistryRecord]> {
  if (cardsByBin.size === 0) return Array.from(registryByBin.entries());
  const rows: Array<[string, GoszakupRegistryRecord]> = [];
  for (const bin of cardsByBin.keys()) {
    const registry = registryByBin.get(bin);
    if (registry) rows.push([bin, registry]);
  }
  return rows;
}

export function mergeLeadsWithKz(
  db: Database.Database,
  companyCards: ScoredCompanyCard[]
): { matches: LeadKzMatch[]; stats: LeadKzMergeStats } {
  const leads = db.prepare(LEAD_SELECT).all() as LeadRow[];

  const cardsByBin = new Map<string, ScoredCompanyCard>();
  for (const card of companyCards) {
    cardsByBin.set(card.bin, card);
  }

  const statByBin = new Map<string, StatGovRecord>();
  const statRows = db.prepare("SELECT * FROM stat_gov_data").all() as Array<Record<string, unknown>>;
  for (const row of statRows) {
    statByBin.set(String(row.bin), mapStatGov(row));
  }

  const registryByBin = new Map<string, GoszakupRegistryRecord>();
  const registryRows = db.prepare("SELECT * FROM goszakup_registry_data").all() as Array<Record<string, unknown>>;
  for (const row of registryRows) {
    registryByBin.set(String(row.bin), mapRegistry(row));
  }

  const matches: LeadKzMatch[] = [];
  const stats: LeadKzMergeStats = {
    total_leads: leads.length,
    with_bin: 0,
    matched_exact: 0,
    matched_fuzzy_stat: 0,
    matched_fuzzy_registry: 0,
    unmatched: 0,
    with_tenders: 0
  };

  for (const lead of leads) {
    const match = matchLeadToKz(lead, cardsByBin, statByBin, registryByBin);
    matches.push(match);

    if (lead.bin) stats.with_bin++;
    if (match.match_type === "exact_bin") stats.matched_exact++;
    else if (match.match_type === "fuzzy_name_stat") stats.matched_fuzzy_stat++;
    else if (match.match_type === "fuzzy_name_registry") stats.matched_fuzzy_registry++;
    else stats.unmatched++;
    if (match.company_card && match.company_card.tender_count_total > 0) stats.with_tenders++;
  }

  return { matches, stats };
}

function matchLeadToKz(
  lead: LeadRow,
  cardsByBin: Map<string, ScoredCompanyCard>,
  statByBin: Map<string, StatGovRecord>,
  registryByBin: Map<string, GoszakupRegistryRecord>
): LeadKzMatch {
  const base: LeadKzMatch = {
    source: lead.source,
    external_id: lead.external_id,
    company_name: lead.company_name,
    bin: lead.bin,
    kz_bin: null,
    match_type: "none",
    match_score: 0,
    stat_gov: null,
    registry: null,
    company_card: null,
    address: lead.address,
    address_clean: lead.address_clean,
    address_raw: lead.address_raw,
    phones: lead.phones,
    phone_normalized: lead.phone_normalized,
    phone_raw: lead.phone_raw,
    crm_status: lead.crm_status,
    lead_score: lead.lead_score,
    registration_date: lead.registration_date,
    company_age_years: lead.company_age_years
  };

  if (lead.bin) {
    const card = cardsByBin.get(lead.bin);
    const stat = statByBin.get(lead.bin);
    const registry = registryByBin.get(lead.bin);
    if (card || stat || registry) {
      return {
        ...base,
        kz_bin: lead.bin,
        match_type: "exact_bin",
        match_score: 1.0,
        stat_gov: stat ?? null,
        registry: registry ?? null,
        company_card: card ?? null
      };
    }
  }

  let bestStat: { bin: string; score: number } | null = null;
  for (const [bin, stat] of scopedStatEntries(cardsByBin, statByBin)) {
    const result = matchNames(stat.name, lead.company_name, FUZZY_THRESHOLD);
    if (result.matched && (!bestStat || result.score > bestStat.score)) {
      bestStat = { bin, score: result.score };
    }
  }
  if (bestStat) {
    return {
      ...base,
      kz_bin: bestStat.bin,
      match_type: "fuzzy_name_stat",
      match_score: bestStat.score,
      stat_gov: statByBin.get(bestStat.bin) ?? null,
      registry: registryByBin.get(bestStat.bin) ?? null,
      company_card: cardsByBin.get(bestStat.bin) ?? null
    };
  }

  let bestRegistry: { bin: string; score: number } | null = null;
  for (const [bin, reg] of scopedRegistryEntries(cardsByBin, registryByBin)) {
    const regName = reg.name_ru ?? reg.name_kz;
    if (!regName) continue;
    const result = matchNames(regName, lead.company_name, FUZZY_THRESHOLD);
    if (result.matched && (!bestRegistry || result.score > bestRegistry.score)) {
      bestRegistry = { bin, score: result.score };
    }
  }
  if (bestRegistry) {
    return {
      ...base,
      kz_bin: bestRegistry.bin,
      match_type: "fuzzy_name_registry",
      match_score: bestRegistry.score,
      stat_gov: statByBin.get(bestRegistry.bin) ?? null,
      registry: registryByBin.get(bestRegistry.bin) ?? null,
      company_card: cardsByBin.get(bestRegistry.bin) ?? null
    };
  }

  return base;
}

/** Drop fuzzy BIN assignments that no longer meet the backfill threshold within the batch. */
export function scrubInvalidLeadBins(
  db: Database.Database,
  cards: ScoredCompanyCard[],
  threshold = BACKFILL_THRESHOLD
): number {
  if (cards.length === 0) return 0;

  const cardsByBin = new Map(cards.map((card) => [card.bin, card]));
  const batchBins = new Set(cards.map((card) => card.bin));
  const leads = db.prepare(`
    SELECT source, external_id, company_name, bin
    FROM leads
    WHERE bin IS NOT NULL AND TRIM(bin) != ''
  `).all() as BackfillLeadRow[];

  const clear = db.prepare(`
    UPDATE leads SET bin = NULL WHERE source = ? AND external_id = ?
  `);

  let cleared = 0;
  for (const lead of leads) {
    const bin = lead.bin?.trim();
    if (!bin || !batchBins.has(bin)) continue;

    const card = cardsByBin.get(bin);
    if (!card) continue;

    const result = matchNames(card.name, lead.company_name, threshold);
    if (!result.matched) {
      clear.run(lead.source, lead.external_id);
      cleared++;
    }
  }
  return cleared;
}

/** When several leads share one batch BIN, keep only the strongest name match. */
export function dedupeLeadBinsByBin(
  db: Database.Database,
  cards: ScoredCompanyCard[],
  threshold = BACKFILL_THRESHOLD
): number {
  if (cards.length === 0) return 0;

  const cardsByBin = new Map(cards.map((card) => [card.bin, card]));
  const batchBins = new Set(cards.map((card) => card.bin));
  const leads = db.prepare(`
    SELECT source, external_id, company_name, bin
    FROM leads
    WHERE bin IS NOT NULL AND TRIM(bin) != ''
  `).all() as BackfillLeadRow[];

  const grouped = new Map<string, BackfillLeadRow[]>();
  for (const lead of leads) {
    const bin = lead.bin?.trim();
    if (!bin || !batchBins.has(bin)) continue;
    const list = grouped.get(bin) ?? [];
    list.push(lead);
    grouped.set(bin, list);
  }

  const clear = db.prepare(`
    UPDATE leads SET bin = NULL WHERE source = ? AND external_id = ?
  `);

  let cleared = 0;
  for (const [bin, binLeads] of grouped.entries()) {
    if (binLeads.length <= 1) continue;
    const card = cardsByBin.get(bin);
    if (!card) continue;

    const ranked = binLeads
      .map((lead) => ({
        lead,
        score: matchNames(card.name, lead.company_name, threshold).score
      }))
      .sort((a, b) => b.score - a.score);

    for (const entry of ranked.slice(1)) {
      clear.run(entry.lead.source, entry.lead.external_id);
      cleared++;
    }
  }

  return cleared;
}

/** Fuzzy-match lead names to KZ company cards and write BIN when missing. */
export function backfillLeadBins(
  db: Database.Database,
  cards: ScoredCompanyCard[],
  threshold = BACKFILL_THRESHOLD
): number {
  const leads = db.prepare(`
    SELECT source, external_id, company_name, bin
    FROM leads
    WHERE bin IS NULL OR TRIM(bin) = ''
  `).all() as BackfillLeadRow[];

  const update = db.prepare(`
    UPDATE leads SET bin = ? WHERE source = ? AND external_id = ?
  `);

  const rankedCards = sortCardsForBackfill(cards);
  const cardPriority = new Map(rankedCards.map((card, index) => [card.bin, index]));
  const candidates: BackfillCandidate[] = [];

  for (const lead of leads) {
    for (const card of rankedCards) {
      const result = matchNames(card.name, lead.company_name, threshold);
      if (result.matched) {
        candidates.push({
          source: lead.source,
          external_id: lead.external_id,
          company_name: lead.company_name,
          bin: card.bin,
          score: result.score,
          cardPriority: cardPriority.get(card.bin) ?? 999
        });
      }
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score
    || a.cardPriority - b.cardPriority
    || a.company_name.localeCompare(b.company_name)
  );

  const assignedLeads = new Set<string>();
  const assignedBins = new Set<string>();
  let updated = 0;

  for (const candidate of candidates) {
    const leadKey = `${candidate.source}:${candidate.external_id}`;
    if (assignedLeads.has(leadKey) || assignedBins.has(candidate.bin)) continue;

    update.run(candidate.bin, candidate.source, candidate.external_id);
    assignedLeads.add(leadKey);
    assignedBins.add(candidate.bin);
    console.log(
      `backfill bin: ${candidate.company_name.slice(0, 40)} → ${candidate.bin} (${candidate.score.toFixed(2)})`
    );
    updated++;
  }

  return updated;
}

/** Persist fuzzy/exact kz_bin matches onto leads.bin for downstream exports. */
export function backfillBinsFromMatches(db: Database.Database, matches: LeadKzMatch[]): number {
  const update = db.prepare(`
    UPDATE leads
    SET bin = ?
    WHERE source = ? AND external_id = ?
      AND (bin IS NULL OR TRIM(bin) = '')
  `);

  let updated = 0;
  for (const match of matches) {
    if (!match.kz_bin || match.match_type === "none" || match.bin) continue;
    update.run(match.kz_bin, match.source, match.external_id);
    updated++;
  }
  return updated;
}

export function writeKzToLeads(db: Database.Database, matches: LeadKzMatch[]): number {
  const updateStmt = db.prepare(`
    UPDATE leads SET
      bin = COALESCE(?, bin),
      registration_date = COALESCE(?, registration_date),
      oked = COALESCE(?, oked),
      oked_name = COALESCE(?, oked_name),
      director = COALESCE(?, director),
      legal_status = COALESCE(?, legal_status),
      company_age_years = COALESCE(?, company_age_years),
      legal_form = COALESCE(?, legal_form)
    WHERE source = ? AND external_id = ?
  `);

  let updated = 0;
  const tx = db.transaction(() => {
    for (const match of matches) {
      if (match.match_type === "none" || !match.stat_gov) continue;
      const stat = match.stat_gov;
      updateStmt.run(
        stat.bin,
        stat.registration_date,
        stat.oked,
        stat.oked_name,
        stat.director,
        stat.legal_status,
        calculateCompanyAgeYears(stat.registration_date),
        stat.kfs_name || parseLegalFormFromName(stat.name),
        match.source,
        match.external_id
      );
      updated++;
    }
  });
  tx();
  return updated;
}

function calculateCompanyAgeYears(registrationDate: string | null): number | null {
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

function mapStatGov(row: Record<string, unknown>): StatGovRecord {
  return {
    bin: String(row.bin),
    name: String(row.name ?? ""),
    registration_date: strOrNull(row.registration_date),
    oked: strOrNull(row.oked),
    oked_name: strOrNull(row.oked_name),
    address: strOrNull(row.address),
    director: strOrNull(row.director),
    legal_status: (strOrNull(row.legal_status) ?? "unknown") as StatGovRecord["legal_status"],
    krp_code: strOrNull(row.krp_code),
    krp_name: strOrNull(row.krp_name),
    kfs_code: strOrNull(row.kfs_code),
    kfs_name: strOrNull(row.kfs_name),
    sector_code: strOrNull(row.sector_code),
    sector_name: strOrNull(row.sector_name),
    updated_at: strOrNull(row.updated_at) ?? undefined,
    raw_snapshot_path: strOrNull(row.raw_snapshot_path)
  };
}

function mapRegistry(row: Record<string, unknown>): GoszakupRegistryRecord {
  return {
    bin: String(row.bin),
    participant_id: strOrNull(row.participant_id),
    name_ru: strOrNull(row.name_ru),
    name_kz: strOrNull(row.name_kz),
    rnn: strOrNull(row.rnn),
    role: strOrNull(row.role),
    residency: strOrNull(row.residency),
    phone: strOrNull(row.phone),
    email: strOrNull(row.email),
    website: strOrNull(row.website),
    registration_date: strOrNull(row.registration_date),
    last_update_date: strOrNull(row.last_update_date),
    kopf: strOrNull(row.kopf),
    ownership_form: strOrNull(row.ownership_form),
    economic_sector: strOrNull(row.economic_sector),
    director_name: strOrNull(row.director_name),
    director_iin: strOrNull(row.director_iin),
    legal_address: strOrNull(row.legal_address),
    location_address: strOrNull(row.location_address),
    full_address_ru: strOrNull(row.full_address_ru),
    reporting_administrator: strOrNull(row.reporting_administrator),
    registry_url: strOrNull(row.registry_url),
    updated_at: String(row.updated_at ?? ""),
    raw_snapshot_path: strOrNull(row.raw_snapshot_path)
  };
}

function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === "" ? null : text;
}
