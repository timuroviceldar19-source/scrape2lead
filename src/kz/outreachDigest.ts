import type Database from "better-sqlite3";
import { KzStorage } from "./kzStorage.js";
import { scoreCompanyCards, type ScoredCompanyCard } from "./kzLeadScore.js";
import { formatLeadPhone, mergeLeadsWithKz, type LeadKzMatch } from "./leadKzMerge.js";
import { groupMatchesByKzBin } from "./unifiedExporter.js";
import { isActiveTenderStatus } from "./tenderTypes.js";

export type OutreachKind = "winner" | "prospect";

export interface OutreachRun {
  id: number;
  started_at: string;
  finished_at: string | null;
}

/** Свежий контракт (победа в закупке), ещё не попадавший в дайджест. */
export interface OutreachWinner {
  bin: string;
  company_name: string;
  director: string | null;
  phone: string | null;
  email: string | null;
  gis_phone: string;
  contract_number: string;
  contract_name: string;
  customer_name: string | null;
  amount: number | null;
  amount_raw: string | null;
  contract_date: string | null;
  status: string | null;
  url: string | null;
}

/** Top-A компания, у которой появились новые активные закупки. */
export interface OutreachProspect {
  card: ScoredCompanyCard;
  new_active_tenders: ProspectTender[];
  gis_phone: string;
  gis_company_names: string;
}

export interface ProspectTender {
  tender_number: string;
  tender_name: string;
  customer_name: string | null;
  amount: number | null;
  status: string | null;
  url: string | null;
}

export interface OutreachDiff {
  winners: OutreachWinner[];
  prospects: OutreachProspect[];
}

export interface OutreachDiffOptions {
  /** Ограничить выборку этими БИНами (обычно batch CSV). Без них — вся база. */
  bins?: string[];
  /** Учитывать только записи с датой >= since (ISO или dd.mm.yyyy). */
  since?: string;
}

interface TenderRow {
  bin: string;
  tender_number: string;
  tender_name: string;
  customer_name: string | null;
  budget_amount: string | null;
  start_date: string | null;
  status: string | null;
  url: string | null;
  parsed_at: string;
}

export function getLastCompletedRun(db: Database.Database): OutreachRun | null {
  const row = db.prepare(`
    SELECT id, started_at, finished_at FROM outreach_runs
    WHERE finished_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get() as OutreachRun | undefined;
  return row ?? null;
}

export function startOutreachRun(db: Database.Database): number {
  const result = db.prepare(
    "INSERT INTO outreach_runs (started_at) VALUES (?)"
  ).run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishOutreachRun(db: Database.Database, runId: number, stats: Record<string, unknown>): void {
  db.prepare("UPDATE outreach_runs SET finished_at = ?, stats_json = ? WHERE id = ?")
    .run(new Date().toISOString(), JSON.stringify(stats), runId);
}

export function registerOutreachItems(
  db: Database.Database,
  runId: number,
  items: Array<{ bin: string; tender_number: string; kind: OutreachKind }>
): number {
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO outreach_items (run_id, bin, tender_number, kind, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSeen = db.prepare(`
    INSERT OR IGNORE INTO outreach_seen (bin, tender_number, kind, first_seen_at)
    VALUES (?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  let inserted = 0;
  db.transaction(() => {
    for (const item of items) {
      insertSeen.run(item.bin, item.tender_number, item.kind, now);
      const result = insertItem.run(runId, item.bin, item.tender_number, item.kind, now);
      inserted += result.changes;
    }
  })();
  return inserted;
}

export function computeOutreachDiff(db: Database.Database, options: OutreachDiffOptions = {}): OutreachDiff {
  const sinceTime = options.since ? parseFlexibleDate(options.since)?.getTime() ?? null : null;
  const binFilter = options.bins && options.bins.length > 0 ? new Set(options.bins) : null;

  const seenWinner = loadSeenPairs(db, "winner");
  const seenProspect = loadSeenPairs(db, "prospect");

  // Победители: контракты supplier-side из goszakup HTML (tender_name начинается с "Договор").
  const contractRows = db.prepare(`
    SELECT bin, tender_number, tender_name, customer_name, budget_amount, start_date, status, url, parsed_at
    FROM tender_data
    WHERE source = 'goszakup.gov.kz' AND tender_name LIKE 'Договор%'
  `).all() as TenderRow[];

  const newContracts = contractRows.filter((row) => {
    if (binFilter && !binFilter.has(row.bin)) return false;
    if (seenWinner.has(pairKey(row.bin, row.tender_number))) return false;
    if (sinceTime !== null && !dateAtOrAfter(row.start_date ?? row.parsed_at, sinceTime)) return false;
    return true;
  });

  const winnerBins = [...new Set(newContracts.map((row) => row.bin))];

  // Проспекты: Top-A карточки с активными закупками, ещё не попадавшими в очередь.
  const storage = new KzStorage({ db });
  const allCards = scoreCompanyCards(storage.getCompanyCards(options.bins));
  const aCards = allCards.filter((card) => card.lead_priority === "A");

  const prospectCandidates = new Map<string, { card: ScoredCompanyCard; tenders: ProspectTender[] }>();
  for (const card of aCards) {
    const newActive = storage.getTendersByBin(card.bin).filter((tender) => {
      if (!isActiveTenderStatus(tender.status)) return false;
      if (seenProspect.has(pairKey(tender.bin, tender.tender_number))) return false;
      if (sinceTime !== null && !dateAtOrAfter(tender.start_date ?? tender.parsed_at, sinceTime)) return false;
      return true;
    });
    if (newActive.length === 0) continue;
    prospectCandidates.set(card.bin, {
      card,
      tenders: newActive.map((tender) => ({
        tender_number: tender.tender_number,
        tender_name: tender.tender_name,
        customer_name: tender.customer_name,
        amount: parseAmount(tender.budget_amount),
        status: tender.status,
        url: tender.url
      }))
    });
  }

  // Контакты: карточки + 2GIS-мердж по затронутым БИНам.
  const contactBins = [...new Set([...winnerBins, ...prospectCandidates.keys()])];
  const contactCards = contactBins.length > 0
    ? scoreCompanyCards(storage.getCompanyCards(contactBins))
    : [];
  const cardsByBin = new Map(contactCards.map((card) => [card.bin, card]));
  const matchesByBin = contactCards.length > 0
    ? groupMatchesByKzBin(mergeLeadsWithKz(db, contactCards).matches)
    : new Map<string, LeadKzMatch[]>();

  const gisPhoneFor = (bin: string): string => {
    const matches = matchesByBin.get(bin) ?? [];
    return matches.map((match) => formatLeadPhone(match)).filter(Boolean).join("; ");
  };

  const winners: OutreachWinner[] = newContracts.map((row) => {
    const card = cardsByBin.get(row.bin);
    return {
      bin: row.bin,
      company_name: card?.name || row.bin,
      director: card?.director ?? null,
      phone: card?.registry_phone ?? null,
      email: card?.registry_email ?? null,
      gis_phone: gisPhoneFor(row.bin),
      contract_number: row.tender_number,
      contract_name: row.tender_name,
      customer_name: row.customer_name,
      amount: parseAmount(row.budget_amount),
      amount_raw: row.budget_amount,
      contract_date: row.start_date,
      status: row.status,
      url: row.url
    };
  }).sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  const prospects: OutreachProspect[] = [...prospectCandidates.values()].map(({ card, tenders }) => {
    const matches = matchesByBin.get(card.bin) ?? [];
    return {
      card,
      new_active_tenders: tenders,
      gis_phone: gisPhoneFor(card.bin),
      gis_company_names: [...new Set(matches.map((match) => match.company_name))].join("; ")
    };
  }).sort((a, b) => (b.card.tender_active_budget_sum ?? 0) - (a.card.tender_active_budget_sum ?? 0));

  return { winners, prospects };
}

export function diffToOutreachItems(diff: OutreachDiff): Array<{ bin: string; tender_number: string; kind: OutreachKind }> {
  const items: Array<{ bin: string; tender_number: string; kind: OutreachKind }> = [];
  for (const winner of diff.winners) {
    items.push({ bin: winner.bin, tender_number: winner.contract_number, kind: "winner" });
  }
  for (const prospect of diff.prospects) {
    for (const tender of prospect.new_active_tenders) {
      items.push({ bin: prospect.card.bin, tender_number: tender.tender_number, kind: "prospect" });
    }
  }
  return items;
}

export function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\u00a0]/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Принимает ISO (2026-06-01[T...]) и dd.mm.yyyy; иначе null. */
export function parseFlexibleDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ddmmyyyy = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) return new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}T00:00:00.000Z`);
  const iso = trimmed.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? new Date(`${iso[0]}T00:00:00.000Z`) : parsed;
  }
  return null;
}

/** Невалидные даты считаем проходящими фильтр (лучше показать лишнее, чем потерять контракт). */
function dateAtOrAfter(value: string | null, sinceTime: number): boolean {
  const parsed = parseFlexibleDate(value);
  if (!parsed) return true;
  return parsed.getTime() >= sinceTime;
}

function pairKey(bin: string, tenderNumber: string): string {
  return `${bin}::${tenderNumber}`;
}

function loadSeenPairs(db: Database.Database, kind: OutreachKind): Set<string> {
  const rows = db.prepare("SELECT bin, tender_number FROM outreach_seen WHERE kind = ?").all(kind) as Array<{ bin: string; tender_number: string }>;
  return new Set(rows.map((row) => pairKey(row.bin, row.tender_number)));
}

/** Одна компания (БИН) — один контракт с максимальной суммой; топ-N по сумме. */
export function pickUniqueWinnersByBin(winners: OutreachWinner[], limit: number): OutreachWinner[] {
  const bestByBin = new Map<string, OutreachWinner>();
  for (const winner of winners) {
    const prev = bestByBin.get(winner.bin);
    const amount = winner.amount ?? 0;
    const prevAmount = prev?.amount ?? 0;
    if (!prev || amount > prevAmount) bestByBin.set(winner.bin, winner);
  }
  return [...bestByBin.values()]
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, limit);
}

/** Последние контракты goszakup по БИНам — для fallback-дайджеста, если diff пуст. */
export function loadRecentGoszakupWinners(
  db: Database.Database,
  bins: string[],
  limit: number
): OutreachWinner[] {
  if (bins.length === 0) return [];

  const placeholders = bins.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT bin, tender_number, tender_name, customer_name, budget_amount, start_date, status, url, parsed_at
       FROM tender_data
       WHERE source LIKE '%goszakup%' AND bin IN (${placeholders})
         AND tender_name LIKE 'Договор%'
       ORDER BY parsed_at DESC`
    )
    .all(...bins) as TenderRow[];

  const storage = new KzStorage({ db });
  const uniqueBins = [...new Set(rows.map((r) => r.bin))];
  const cards = scoreCompanyCards(storage.getCompanyCards(uniqueBins));
  const byBin = new Map(cards.map((c) => [c.bin, c]));

  const winners: OutreachWinner[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = pairKey(row.bin, row.tender_number);
    if (seen.has(key)) continue;
    seen.add(key);
    const card = byBin.get(row.bin);
    winners.push({
      bin: row.bin,
      company_name: card?.name ?? row.bin,
      director: card?.director ?? null,
      phone: card?.registry_phone ?? null,
      email: card?.registry_email ?? null,
      gis_phone: "",
      contract_number: row.tender_number,
      contract_name: row.tender_name,
      customer_name: row.customer_name,
      amount: parseAmount(row.budget_amount),
      amount_raw: row.budget_amount,
      contract_date: row.start_date,
      status: row.status,
      url: row.url
    });
  }

  return pickUniqueWinnersByBin(winners, limit);
}
