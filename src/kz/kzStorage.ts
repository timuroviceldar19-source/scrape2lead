import Database from "better-sqlite3";
import { runMigrations } from "../storage/migrations.js";
import {
  ACTIVE_TENDER_STATUSES_EXACT,
  ACTIVE_TENDER_STATUSES_LATIN,
  type CompanyCard,
  type EnrichError,
  type StatGovRecord,
  type TenderRecord
} from "./tenderTypes.js";
import type { GoszakupRegistryRecord } from "./registryTypes.js";

export interface KzStorageOptions {
  databasePath?: string;
  db?: Database.Database;
}

const DEFAULT_DB_PATH = "data/scrape2lead.db";

export class KzStorage {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(options: KzStorageOptions = {}) {
    this.db = options.db ?? new Database(options.databasePath ?? DEFAULT_DB_PATH);
    this.ownsDb = options.db === undefined;
    runMigrations(this.db);
  }

  getStatGovByBin(bin: string): StatGovRecord | null {
    const row = this.db.prepare("SELECT * FROM stat_gov_data WHERE bin = ?").get(bin) as Record<string, unknown> | undefined;
    return row ? mapStatGov(row) : null;
  }

  getStatGovByBins(bins: string[]): StatGovRecord[] {
    if (bins.length === 0) return [];
    const placeholders = bins.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM stat_gov_data WHERE bin IN (${placeholders}) ORDER BY bin`).all(...bins) as Array<Record<string, unknown>>;
    return rows.map(mapStatGov);
  }

  isStatGovFresh(bin: string, ttlDays: number, now = new Date()): boolean {
    const row = this.db.prepare("SELECT updated_at FROM stat_gov_data WHERE bin = ?").get(bin) as { updated_at: string | null } | undefined;
    if (!row?.updated_at) return false;
    const updatedAt = new Date(row.updated_at);
    if (Number.isNaN(updatedAt.getTime())) return false;
    return now.getTime() - updatedAt.getTime() <= ttlDays * 24 * 60 * 60 * 1000;
  }

  getTendersByBin(bin: string): TenderRecord[] {
    const rows = this.db.prepare("SELECT * FROM tender_data WHERE bin = ? ORDER BY parsed_at DESC, id DESC").all(bin) as Array<Record<string, unknown>>;
    return rows.map(mapTender);
  }

  getTendersByBins(bins: string[]): TenderRecord[] {
    if (bins.length === 0) return [];
    const placeholders = bins.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM tender_data WHERE bin IN (${placeholders}) ORDER BY bin, parsed_at DESC, id DESC`).all(...bins) as Array<Record<string, unknown>>;
    return rows.map(mapTender);
  }

  getCompanyCards(bins?: string[]): CompanyCard[] {
    const params = bins && bins.length > 0 ? bins : [];
    const filter = params.length > 0 ? `WHERE c.bin IN (${params.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`
      WITH company_bins AS (
        SELECT bin FROM stat_gov_data
        UNION
        SELECT bin FROM goszakup_registry_data
      )
      SELECT
        c.bin,
        COALESCE(s.name, r.name_ru) AS name,
        COALESCE(s.registration_date, r.registration_date) AS registration_date,
        s.oked, s.oked_name,
        COALESCE(s.address, r.legal_address, r.location_address) AS address,
        COALESCE(s.director, r.director_name) AS director,
        s.legal_status, s.krp_code, s.krp_name, s.kfs_code, s.kfs_name,
        s.sector_code, s.sector_name,
        COALESCE(s.updated_at, r.updated_at) AS updated_at,
        COALESCE(s.raw_snapshot_path, r.raw_snapshot_path) AS raw_snapshot_path,
        COUNT(t.id) AS tender_count_total,
        SUM(CASE WHEN ${activeTenderStatusSqlCase("t.status")} THEN 1 ELSE 0 END) AS tender_count_active,
        SUM(CASE
          WHEN t.budget_amount IS NOT NULL AND TRIM(t.budget_amount) != ''
          THEN CAST(REPLACE(REPLACE(t.budget_amount, ' ', ''), ',', '.') AS REAL)
          ELSE NULL
        END) AS tender_budget_sum,
        SUM(CASE
          WHEN ${activeTenderStatusSqlCase("t.status")}
            AND t.budget_amount IS NOT NULL AND TRIM(t.budget_amount) != ''
          THEN CAST(REPLACE(REPLACE(t.budget_amount, ' ', ''), ',', '.') AS REAL)
          ELSE NULL
        END) AS tender_active_budget_sum,
        GROUP_CONCAT(DISTINCT t.source) AS tender_sources,
        MAX(NULLIF(t.end_date, '')) AS last_tender_end_date,
        r.phone AS registry_phone,
        r.email AS registry_email,
        r.website AS registry_website,
        r.participant_id,
        r.role AS registry_role
      FROM company_bins c
      LEFT JOIN stat_gov_data s ON s.bin = c.bin
      LEFT JOIN tender_data t ON t.bin = c.bin
      LEFT JOIN goszakup_registry_data r ON r.bin = c.bin
      ${filter}
      GROUP BY c.bin
      ORDER BY name COLLATE NOCASE
    `).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...mapStatGov(row),
      tender_count_total: Number(row.tender_count_total ?? 0),
      tender_count_active: Number(row.tender_count_active ?? 0),
      tender_budget_sum: row.tender_budget_sum === null || row.tender_budget_sum === undefined
        ? null
        : Number(row.tender_budget_sum),
      tender_active_budget_sum: row.tender_active_budget_sum === null || row.tender_active_budget_sum === undefined
        ? null
        : Number(row.tender_active_budget_sum),
      tender_sources: row.tender_sources ? String(row.tender_sources) : "",
      last_tender_end_date: stringOrNull(row.last_tender_end_date),
      registry_phone: stringOrNull(row.registry_phone),
      registry_email: stringOrNull(row.registry_email),
      registry_website: stringOrNull(row.registry_website),
      participant_id: stringOrNull(row.participant_id),
      registry_role: stringOrNull(row.registry_role)
    }));
  }

  upsertStatGov(record: StatGovRecord): void {
    this.db.prepare(`
      INSERT INTO stat_gov_data (
        bin, name, registration_date, oked, oked_name, address, director,
        legal_status, krp_code, krp_name, kfs_code, kfs_name, sector_code,
        sector_name, updated_at, raw_snapshot_path
      ) VALUES (
        @bin, @name, @registration_date, @oked, @oked_name, @address, @director,
        @legal_status, @krp_code, @krp_name, @kfs_code, @kfs_name, @sector_code,
        @sector_name, @updated_at, @raw_snapshot_path
      )
      ON CONFLICT(bin) DO UPDATE SET
        name = excluded.name,
        registration_date = excluded.registration_date,
        oked = excluded.oked,
        oked_name = excluded.oked_name,
        address = excluded.address,
        director = excluded.director,
        legal_status = excluded.legal_status,
        krp_code = excluded.krp_code,
        krp_name = excluded.krp_name,
        kfs_code = excluded.kfs_code,
        kfs_name = excluded.kfs_name,
        sector_code = excluded.sector_code,
        sector_name = excluded.sector_name,
        updated_at = excluded.updated_at,
        raw_snapshot_path = excluded.raw_snapshot_path
    `).run({
      ...record,
      updated_at: record.updated_at ?? new Date().toISOString(),
      raw_snapshot_path: record.raw_snapshot_path ?? null
    });
  }

  upsertTenders(records: TenderRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO tender_data (
        source, bin, tender_number, tender_name, customer_name, budget_amount,
        currency, start_date, end_date, status, method, url, parsed_at
      ) VALUES (
        @source, @bin, @tender_number, @tender_name, @customer_name, @budget_amount,
        @currency, @start_date, @end_date, @status, @method, @url, @parsed_at
      )
      ON CONFLICT(source, bin, tender_number) DO UPDATE SET
        tender_name = excluded.tender_name,
        customer_name = excluded.customer_name,
        budget_amount = excluded.budget_amount,
        currency = excluded.currency,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        status = excluded.status,
        method = excluded.method,
        url = excluded.url,
        parsed_at = excluded.parsed_at
    `);

    this.db.transaction(() => {
      for (const record of records) {
        stmt.run({
          ...record,
          customer_name: record.customer_name ?? null,
          budget_amount: record.budget_amount ?? null,
          start_date: record.start_date ?? null,
          end_date: record.end_date ?? null,
          status: record.status ?? null,
          method: record.method ?? null,
          url: record.url ?? null
        });
      }
    })();
  }

  getGoszakupRegistryByBin(bin: string): GoszakupRegistryRecord | null {
    const row = this.db.prepare("SELECT * FROM goszakup_registry_data WHERE bin = ?").get(bin) as Record<string, unknown> | undefined;
    return row ? mapRegistry(row) : null;
  }

  isGoszakupRegistryFresh(bin: string, ttlDays: number, now = new Date()): boolean {
    const row = this.db.prepare("SELECT updated_at FROM goszakup_registry_data WHERE bin = ?").get(bin) as { updated_at: string | null } | undefined;
    if (!row?.updated_at) return false;
    const updatedAt = new Date(row.updated_at);
    if (Number.isNaN(updatedAt.getTime())) return false;
    return now.getTime() - updatedAt.getTime() <= ttlDays * 24 * 60 * 60 * 1000;
  }

  upsertGoszakupRegistry(record: GoszakupRegistryRecord): void {
    this.db.prepare(`
      INSERT INTO goszakup_registry_data (
        bin, participant_id, name_ru, name_kz, rnn, role, residency,
        phone, email, website, registration_date, last_update_date,
        kopf, ownership_form, economic_sector, director_name, director_iin,
        legal_address, location_address, registry_url, updated_at, raw_snapshot_path
      ) VALUES (
        @bin, @participant_id, @name_ru, @name_kz, @rnn, @role, @residency,
        @phone, @email, @website, @registration_date, @last_update_date,
        @kopf, @ownership_form, @economic_sector, @director_name, @director_iin,
        @legal_address, @location_address, @registry_url, @updated_at, @raw_snapshot_path
      )
      ON CONFLICT(bin) DO UPDATE SET
        participant_id = excluded.participant_id,
        name_ru = excluded.name_ru,
        name_kz = excluded.name_kz,
        rnn = excluded.rnn,
        role = excluded.role,
        residency = excluded.residency,
        phone = excluded.phone,
        email = excluded.email,
        website = excluded.website,
        registration_date = excluded.registration_date,
        last_update_date = excluded.last_update_date,
        kopf = excluded.kopf,
        ownership_form = excluded.ownership_form,
        economic_sector = excluded.economic_sector,
        director_name = excluded.director_name,
        director_iin = excluded.director_iin,
        legal_address = excluded.legal_address,
        location_address = excluded.location_address,
        registry_url = excluded.registry_url,
        updated_at = excluded.updated_at,
        raw_snapshot_path = excluded.raw_snapshot_path
    `).run({
      ...record,
      updated_at: record.updated_at ?? new Date().toISOString(),
      raw_snapshot_path: record.raw_snapshot_path ?? null
    });
  }

  recordEnrichError(bin: string, stage: string, message: string): void {
    this.db.prepare(`
      INSERT INTO kz_enrich_errors (bin, stage, message, created_at)
      VALUES (?, ?, ?, ?)
    `).run(bin, stage, message, new Date().toISOString());
  }

  getEnrichErrors(): EnrichError[] {
    return this.db.prepare("SELECT * FROM kz_enrich_errors ORDER BY created_at DESC, id DESC").all() as EnrichError[];
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

function mapStatGov(row: Record<string, unknown>): StatGovRecord {
  return {
    bin: String(row.bin),
    name: String(row.name ?? ""),
    registration_date: stringOrNull(row.registration_date),
    oked: stringOrNull(row.oked),
    oked_name: stringOrNull(row.oked_name),
    address: stringOrNull(row.address),
    director: stringOrNull(row.director),
    legal_status: (stringOrNull(row.legal_status) ?? "unknown") as StatGovRecord["legal_status"],
    krp_code: stringOrNull(row.krp_code),
    krp_name: stringOrNull(row.krp_name),
    kfs_code: stringOrNull(row.kfs_code),
    kfs_name: stringOrNull(row.kfs_name),
    sector_code: stringOrNull(row.sector_code),
    sector_name: stringOrNull(row.sector_name),
    updated_at: stringOrNull(row.updated_at) ?? undefined,
    raw_snapshot_path: stringOrNull(row.raw_snapshot_path)
  };
}

function mapTender(row: Record<string, unknown>): TenderRecord {
  return {
    source: String(row.source) as TenderRecord["source"],
    bin: String(row.bin),
    tender_number: String(row.tender_number),
    tender_name: String(row.tender_name),
    customer_name: stringOrNull(row.customer_name),
    budget_amount: stringOrNull(row.budget_amount),
    currency: String(row.currency ?? "KZT"),
    start_date: stringOrNull(row.start_date),
    end_date: stringOrNull(row.end_date),
    status: stringOrNull(row.status),
    method: stringOrNull(row.method),
    url: stringOrNull(row.url),
    parsed_at: String(row.parsed_at)
  };
}

function mapRegistry(row: Record<string, unknown>): GoszakupRegistryRecord {
  return {
    bin: String(row.bin),
    participant_id: stringOrNull(row.participant_id),
    name_ru: stringOrNull(row.name_ru),
    name_kz: stringOrNull(row.name_kz),
    rnn: stringOrNull(row.rnn),
    role: stringOrNull(row.role),
    residency: stringOrNull(row.residency),
    phone: stringOrNull(row.phone),
    email: stringOrNull(row.email),
    website: stringOrNull(row.website),
    registration_date: stringOrNull(row.registration_date),
    last_update_date: stringOrNull(row.last_update_date),
    kopf: stringOrNull(row.kopf),
    ownership_form: stringOrNull(row.ownership_form),
    economic_sector: stringOrNull(row.economic_sector),
    director_name: stringOrNull(row.director_name),
    director_iin: stringOrNull(row.director_iin),
    legal_address: stringOrNull(row.legal_address),
    location_address: stringOrNull(row.location_address),
    registry_url: stringOrNull(row.registry_url),
    updated_at: String(row.updated_at ?? ""),
    raw_snapshot_path: stringOrNull(row.raw_snapshot_path)
  };
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === "" ? null : text;
}

function activeTenderStatusSqlCase(column: string): string {
  const latin = Array.from(ACTIVE_TENDER_STATUSES_LATIN)
    .map((status) => `'${status}'`)
    .join(", ");
  const exact = Array.from(ACTIVE_TENDER_STATUSES_EXACT)
    .map((status) => `'${status.replace(/'/g, "''")}'`)
    .join(", ");
  return `UPPER(COALESCE(${column}, '')) IN (${latin}) OR COALESCE(${column}, '') IN (${exact})`;
}
