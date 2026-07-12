import Database from "better-sqlite3";
import { runMigrations } from "../storage/migrations.js";
import type { GoszakupRegistryRecord } from "./registryTypes.js";

export interface KzStorageOptions {
  databasePath?: string;
  db?: Database.Database;
}

export interface EnrichError {
  id: number;
  bin: string;
  stage: string;
  message: string;
  created_at: string;
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

  getGoszakupRegistryByBin(bin: string): GoszakupRegistryRecord | null {
    const row = this.db.prepare("SELECT * FROM goszakup_registry_data WHERE bin = ?").get(bin) as Record<string, unknown> | undefined;
    return row ? mapRegistry(row) : null;
  }

  isGoszakupRegistryFresh(
    bin: string,
    ttlDays: number,
    now = new Date(),
    options: { requireAnyContact?: boolean } = {}
  ): boolean {
    const row = this.db.prepare("SELECT updated_at, phone, email, website FROM goszakup_registry_data WHERE bin = ?")
      .get(bin) as { updated_at: string | null; phone: string | null; email: string | null; website: string | null } | undefined;
    if (!row?.updated_at) return false;
    if (options.requireAnyContact && !hasAnyContact(row)) return false;
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
        legal_address, location_address, full_address_ru, reporting_administrator,
        registry_url, updated_at, raw_snapshot_path
      ) VALUES (
        @bin, @participant_id, @name_ru, @name_kz, @rnn, @role, @residency,
        @phone, @email, @website, @registration_date, @last_update_date,
        @kopf, @ownership_form, @economic_sector, @director_name, @director_iin,
        @legal_address, @location_address, @full_address_ru, @reporting_administrator,
        @registry_url, @updated_at, @raw_snapshot_path
      )
      ON CONFLICT(bin) DO UPDATE SET
        participant_id = excluded.participant_id, name_ru = excluded.name_ru,
        name_kz = excluded.name_kz, rnn = excluded.rnn, role = excluded.role,
        residency = excluded.residency, phone = excluded.phone, email = excluded.email,
        website = excluded.website, registration_date = excluded.registration_date,
        last_update_date = excluded.last_update_date, kopf = excluded.kopf,
        ownership_form = excluded.ownership_form, economic_sector = excluded.economic_sector,
        director_name = excluded.director_name, director_iin = excluded.director_iin,
        legal_address = excluded.legal_address, location_address = excluded.location_address,
        full_address_ru = excluded.full_address_ru, reporting_administrator = excluded.reporting_administrator,
        registry_url = excluded.registry_url, updated_at = excluded.updated_at,
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
    full_address_ru: stringOrNull(row.full_address_ru),
    reporting_administrator: stringOrNull(row.reporting_administrator),
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

function hasAnyContact(row: { phone: string | null; email: string | null; website: string | null }): boolean {
  return Boolean(row.phone?.trim() || row.email?.trim() || row.website?.trim());
}
