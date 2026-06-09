import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  CaptchaEventInput,
  CleanupOlderOptions,
  CleanupRecentOptions,
  CompanyTaskRow,
  CompanyTaskStatus,
  Lead,
  ListRawSnapshotsFilter,
  ParseAttempt,
  ParseJobRow,
  ParseJobStatus,
  ProxyRotationInput,
  RawSnapshotRow,
  SaveRawSnapshotInput,
  SourceId
} from "../types.js";
import { runMigrations } from "./migrations.js";
import { computeJobTelemetry, type JobTelemetry } from "../core/telemetry.js";
import type {
  ClaimTaskInput,
  CreateParseJobInput,
  EnqueueCompanyTaskInput,
  IStorage
} from "./interface.js";
export type { JobTelemetry };
export type {
  ClaimTaskInput,
  CreateParseJobInput,
  EnqueueCompanyTaskInput,
  IStorage
} from "./interface.js";

/**
 * SQLite-backed default implementation of {@link IStorage}.
 *
 * `better-sqlite3` is a synchronous driver, so the methods are declared
 * `async` purely to satisfy the contract — every body still runs to
 * completion before its (immediately-resolved) Promise is returned. The
 * Postgres implementation in `src/storage/postgres/` shares the same
 * async surface but actually awaits the network.
 */
export class Storage implements IStorage {
  private readonly db: Database.Database;
  private readonly rawSnapshotDir: string | null;

  constructor(databasePath: string, rawSnapshotDir?: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.rawSnapshotDir = rawSnapshotDir ? path.resolve(rawSnapshotDir) : null;
    runMigrations(this.db);
  }

  /**
   * Absolute path of the directory where raw snapshot payloads are persisted
   * to disk, or `null` when no directory is configured (inline-only mode).
   */
  getRawSnapshotDir(): string | null {
    return this.rawSnapshotDir;
  }

  async upsertLead(lead: Lead): Promise<void> {
    const insertLead = this.db.prepare(`
      INSERT INTO leads (
        source, external_id, company_name, category, city, address, phones,
        email, website, social_links, messenger_links, parsed_at, incomplete,
        rating, review_count, product_count, shop_categories,
        lead_id, source_search_city, merchant_city_guess, city_status,
        address_raw, address_clean, phone_raw, phone_normalized, phone_status,
        email_raw, email_status, kaspi_profile_url, real_website, messenger_flags,
        lead_score, priority, contactability, crm_status, next_action, parser_note,
        bin, registration_date, oked, oked_name, director, founder,
        legal_status, company_age_years, legal_form
      ) VALUES (
        @source, @external_id, @company_name, @category, @city, @address, @phones,
        @email, @website, @social_links, @messenger_links, @parsed_at, @incomplete,
        @rating, @review_count, @product_count, @shop_categories,
        @lead_id, @source_search_city, @merchant_city_guess, @city_status,
        @address_raw, @address_clean, @phone_raw, @phone_normalized, @phone_status,
        @email_raw, @email_status, @kaspi_profile_url, @real_website, @messenger_flags,
        @lead_score, @priority, @contactability, @crm_status, @next_action, @parser_note,
        @bin, @registration_date, @oked, @oked_name, @director, @founder,
        @legal_status, @company_age_years, @legal_form
      )
      ON CONFLICT(source, external_id) DO UPDATE SET
        company_name = excluded.company_name,
        category = excluded.category,
        city = excluded.city,
        address = excluded.address,
        phones = excluded.phones,
        email = excluded.email,
        website = excluded.website,
        social_links = excluded.social_links,
        messenger_links = excluded.messenger_links,
        parsed_at = excluded.parsed_at,
        incomplete = excluded.incomplete,
        rating = excluded.rating,
        review_count = excluded.review_count,
        product_count = excluded.product_count,
        shop_categories = excluded.shop_categories,
        lead_id = excluded.lead_id,
        source_search_city = excluded.source_search_city,
        merchant_city_guess = excluded.merchant_city_guess,
        city_status = excluded.city_status,
        address_raw = excluded.address_raw,
        address_clean = excluded.address_clean,
        phone_raw = excluded.phone_raw,
        phone_normalized = excluded.phone_normalized,
        phone_status = excluded.phone_status,
        email_raw = excluded.email_raw,
        email_status = excluded.email_status,
        kaspi_profile_url = excluded.kaspi_profile_url,
        real_website = excluded.real_website,
        messenger_flags = excluded.messenger_flags,
        lead_score = excluded.lead_score,
        priority = excluded.priority,
        contactability = excluded.contactability,
        crm_status = excluded.crm_status,
        next_action = excluded.next_action,
        parser_note = excluded.parser_note,
        bin = excluded.bin,
        registration_date = excluded.registration_date,
        oked = excluded.oked,
        oked_name = excluded.oked_name,
        director = excluded.director,
        founder = excluded.founder,
        legal_status = excluded.legal_status,
        company_age_years = excluded.company_age_years,
        legal_form = excluded.legal_form
    `);
    const insertPhone = this.db.prepare(`
      INSERT OR IGNORE INTO lead_phones (phone, source, external_id)
      VALUES (?, ?, ?)
    `);

    this.db.transaction(() => {
      insertLead.run({
        ...lead,
        phones: JSON.stringify(lead.phones),
        social_links: JSON.stringify(lead.social_links),
        messenger_links: JSON.stringify(lead.messenger_links),
        shop_categories: lead.shop_categories ? JSON.stringify(lead.shop_categories) : null,
        incomplete: lead.incomplete ? 1 : 0,
        // Provide explicit nulls for optional fields to satisfy better-sqlite3 named parameters
        rating: lead.rating ?? null,
        review_count: lead.review_count ?? null,
        product_count: lead.product_count ?? null,
        lead_id: lead.lead_id ?? null,
        source_search_city: lead.source_search_city ?? null,
        merchant_city_guess: lead.merchant_city_guess ?? null,
        city_status: lead.city_status ?? null,
        address_raw: lead.address_raw ?? null,
        address_clean: lead.address_clean ?? null,
        phone_raw: lead.phone_raw ?? null,
        phone_normalized: lead.phone_normalized ?? null,
        phone_status: lead.phone_status ?? null,
        email_raw: lead.email_raw ?? null,
        email_status: lead.email_status ?? null,
        kaspi_profile_url: lead.kaspi_profile_url ?? null,
        real_website: lead.real_website ?? null,
        messenger_flags: lead.messenger_flags ?? null,
        lead_score: lead.lead_score ?? null,
        priority: lead.priority ?? null,
        contactability: lead.contactability ?? null,
        crm_status: lead.crm_status ?? null,
        next_action: lead.next_action ?? null,
        parser_note: lead.parser_note ?? null,
        bin: lead.bin ?? null,
        registration_date: lead.registration_date ?? null,
        oked: lead.oked ?? null,
        oked_name: lead.oked_name ?? null,
        director: lead.director ?? null,
        founder: lead.founder ?? null,
        legal_status: lead.legal_status ?? null,
        company_age_years: lead.company_age_years ?? null,
        legal_form: lead.legal_form ?? null
      });
      for (const phone of lead.phones) {
        insertPhone.run(phone, lead.source, lead.external_id);
      }
    })();
  }

  /**
   * Legacy raw-payload writer. Retained for backwards compatibility with callers
   * that haven't been migrated to {@link saveRawSnapshot}. Writes to the v1
   * `raw_records` table only — does not touch `raw_snapshots`.
   */
  saveRaw(source: string, externalId: string | undefined, kind: string, payload: unknown): void {
    this.db.prepare(`
      INSERT INTO raw_records (source, external_id, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(source, externalId ?? null, kind, JSON.stringify(payload), new Date().toISOString());
  }

  async saveAttempt(attempt: ParseAttempt): Promise<void> {
    this.db.prepare(`
      INSERT INTO parse_attempts (
        company_task_id, job_id, source, external_id, attempt_no,
        result, error_type, message, proxy_id, duration_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.companyTaskId ?? null,
      attempt.jobId ?? null,
      attempt.source,
      attempt.externalId ?? null,
      attempt.attemptNo ?? null,
      attempt.status,
      attempt.errorType ?? null,
      attempt.message ?? null,
      attempt.proxyId ?? null,
      attempt.durationMs ?? null,
      new Date().toISOString()
    );
  }

  private mapRowToLead(row: Record<string, unknown>): Lead {
    return {
      source: String(row.source),
      external_id: String(row.external_id),
      company_name: String(row.company_name),
      category: String(row.category),
      city: String(row.city),
      address: String(row.address),
      phones: JSON.parse(String(row.phones)) as string[],
      email: row.email ? String(row.email) : null,
      website: row.website ? String(row.website) : null,
      social_links: JSON.parse(String(row.social_links)) as string[],
      messenger_links: JSON.parse(String(row.messenger_links)) as string[],
      parsed_at: String(row.parsed_at),
      incomplete: Boolean(row.incomplete),
      // Kaspi-specific fields
      rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : undefined,
      review_count: row.review_count !== null && row.review_count !== undefined ? Number(row.review_count) : undefined,
      product_count: row.product_count !== null && row.product_count !== undefined ? Number(row.product_count) : undefined,
      shop_categories: row.shop_categories ? (JSON.parse(String(row.shop_categories)) as string[]) : undefined,
      // CRM-ready fields
      lead_id: row.lead_id ? String(row.lead_id) : undefined,
      source_search_city: row.source_search_city ? String(row.source_search_city) : undefined,
      merchant_city_guess: row.merchant_city_guess ? String(row.merchant_city_guess) : undefined,
      city_status: row.city_status ? String(row.city_status) as "ok" | "mismatch" | "needs_check" : undefined,
      address_raw: row.address_raw ? String(row.address_raw) : undefined,
      address_clean: row.address_clean ? String(row.address_clean) : undefined,
      address_status: row.address_status ? String(row.address_status) as "valid" | "invalid" | "empty" : undefined,
      phone_raw: row.phone_raw ? String(row.phone_raw) : undefined,
      phone_normalized: row.phone_normalized ? String(row.phone_normalized) : undefined,
      phone_status: row.phone_status ? String(row.phone_status) as "valid" | "invalid" | "empty" : undefined,
      email_raw: row.email_raw ? String(row.email_raw) : undefined,
      email_status: row.email_status ? String(row.email_status) as "valid" | "invalid" | "empty" : undefined,
      kaspi_profile_url: row.kaspi_profile_url ? String(row.kaspi_profile_url) : undefined,
      real_website: row.real_website ? String(row.real_website) : undefined,
      website_status: row.website_status ? String(row.website_status) as "valid" | "invalid" | "empty" : undefined,
      messenger_flags: row.messenger_flags ? String(row.messenger_flags) : undefined,
      lead_score: row.lead_score !== null && row.lead_score !== undefined ? Number(row.lead_score) : undefined,
      priority: row.priority ? String(row.priority) as "A" | "B" | "C" | "D" : undefined,
      contactability: row.contactability ? String(row.contactability) as "Phone ready" | "No usable contact" : undefined,
      crm_status: row.crm_status ? String(row.crm_status) as "Ready to call" | "Needs enrichment" | "Ready to contact" | "Needs manual review" | "Not enough data" : undefined,
      next_action: row.next_action ? String(row.next_action) : undefined,
      parser_note: row.parser_note ? String(row.parser_note) : undefined,
      // Enrichment tracking fields
      enrichment_source: row.enrichment_source ? String(row.enrichment_source) as "2gis" | "google" | "none" : undefined,
      enrichment_url: row.enrichment_url ? String(row.enrichment_url) : undefined,
      confidence_score: row.confidence_score !== null && row.confidence_score !== undefined ? Number(row.confidence_score) : undefined,
      enrichment_status: row.enrichment_status ? String(row.enrichment_status) as "pending" | "enriched" | "manual_review" | "not_found" | "failed" : undefined,
      enrichment_attempted_at: row.enrichment_attempted_at ? String(row.enrichment_attempted_at) : undefined,
      enrichment_error: row.enrichment_error !== null && row.enrichment_error !== undefined ? String(row.enrichment_error) : null,
      found_name: row.found_name ? String(row.found_name) : undefined,
      found_category: row.found_category ? String(row.found_category) : undefined,
      bin: row.bin ? String(row.bin) : undefined,
      registration_date: row.registration_date ? String(row.registration_date) : undefined,
      oked: row.oked ? String(row.oked) : undefined,
      oked_name: row.oked_name ? String(row.oked_name) : undefined,
      director: row.director ? String(row.director) : undefined,
      founder: row.founder ? String(row.founder) : undefined,
      legal_status: row.legal_status ? String(row.legal_status) as "active" | "inactive" | "liquidated" | "reorganizing" | "unknown" : undefined,
      company_age_years: row.company_age_years !== null && row.company_age_years !== undefined ? Number(row.company_age_years) : undefined,
      legal_form: row.legal_form ? String(row.legal_form) : undefined
    };
  }

  async listLeads(): Promise<Lead[]> {
    const rows = this.db.prepare("SELECT * FROM leads ORDER BY company_name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRowToLead(row));
  }

  async getLeadsNeedingEnrichment(
    limit = 100,
    city?: string,
    includeReadyToCall = false
  ): Promise<Lead[]> {
    // Default: only leads that the parser flagged as 'Needs enrichment' —
    // these are leads where at least one contact channel is missing or
    // invalid and they need a 2GIS lookup to fill the gap.
    //
    // Optional: also pull in 'Ready to call' leads. These come from sources
    // like Kaspi that already validate a phone number but do not return
    // address or website. Running enrichment on them upgrades them to
    // 'Ready to contact' (with address/website) or leaves them in
    // 'Ready to call' (no upgrade). 'enriched' rows are excluded so we
    // never re-process a lead whose enrichment already succeeded.
    const crmFilter = includeReadyToCall
      ? `crm_status IN ('Needs enrichment', 'Ready to call')`
      : `crm_status = 'Needs enrichment'`;

    let sql = `
      SELECT * FROM leads
      WHERE ${crmFilter}
        AND (
          COALESCE(phone_status,   'invalid') != 'valid' OR
          COALESCE(address_status, 'invalid') != 'valid' OR
          COALESCE(website_status, 'invalid') != 'valid'
        )
        AND (enrichment_status IS NULL OR enrichment_status = 'pending' OR enrichment_status = 'failed')
    `;
    const params: unknown[] = [];

    if (city) {
      sql += ` AND city = ?`;
      params.push(city);
    }

    sql += ` ORDER BY lead_score DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRowToLead(row));
  }

  async updateLeadEnrichment(
    leadId: string,
    data: Partial<Pick<Lead,
      'phone_raw' | 'phone_normalized' | 'phone_status' |
      'address_raw' | 'address_clean' | 'address_status' |
      'real_website' | 'website_status' |
      'enrichment_source' | 'enrichment_url' | 'confidence_score' |
      'enrichment_status' | 'enrichment_attempted_at' | 'enrichment_error' |
      'lead_score' | 'priority' | 'contactability' | 'crm_status' | 'next_action' | 'found_name' | 'found_category'
    >>
  ): Promise<void> {
    const updateLead = this.db.prepare(`
      UPDATE leads SET
        phone_raw = COALESCE(@phone_raw, phone_raw),
        phone_normalized = COALESCE(@phone_normalized, phone_normalized),
        phone_status = COALESCE(@phone_status, phone_status),
        address_raw = COALESCE(@address_raw, address_raw),
        address_clean = COALESCE(@address_clean, address_clean),
        address_status = COALESCE(@address_status, address_status),
        real_website = COALESCE(@real_website, real_website),
        website_status = COALESCE(@website_status, website_status),
        enrichment_source = COALESCE(@enrichment_source, enrichment_source),
        enrichment_url = COALESCE(@enrichment_url, enrichment_url),
        confidence_score = COALESCE(@confidence_score, confidence_score),
        enrichment_status = COALESCE(@enrichment_status, enrichment_status),
        enrichment_attempted_at = COALESCE(@enrichment_attempted_at, enrichment_attempted_at),
        enrichment_error = @enrichment_error,
        lead_score = COALESCE(@lead_score, lead_score),
        priority = COALESCE(@priority, priority),
        contactability = COALESCE(@contactability, contactability),
        crm_status = COALESCE(@crm_status, crm_status),
        next_action = COALESCE(@next_action, next_action),
        found_name = COALESCE(@found_name, found_name),
        found_category = COALESCE(@found_category, found_category)
      WHERE lead_id = @lead_id
    `);

    updateLead.run({ 
      lead_id: leadId,
      phone_raw: data.phone_raw ?? null,
      phone_normalized: data.phone_normalized ?? null,
      phone_status: data.phone_status ?? null,
      address_raw: data.address_raw ?? null,
      address_clean: data.address_clean ?? null,
      address_status: data.address_status ?? null,
      real_website: data.real_website ?? null,
      website_status: data.website_status ?? null,
      enrichment_source: data.enrichment_source ?? null,
      enrichment_url: data.enrichment_url ?? null,
      confidence_score: data.confidence_score ?? null,
      enrichment_status: data.enrichment_status ?? null,
      enrichment_attempted_at: data.enrichment_attempted_at ?? null,
      enrichment_error: data.enrichment_error ?? null,
      lead_score: data.lead_score ?? null,
      priority: data.priority ?? null,
      contactability: data.contactability ?? null,
      crm_status: data.crm_status ?? null,
      next_action: data.next_action ?? null,
      found_name: data.found_name ?? null,
      found_category: data.found_category ?? null
    });
  }

  /**
   * Legacy proxy-event writer. Forwards to {@link saveProxyRotation} so the new
   * `proxy_channel` / `ip` / `rotated_at` / `cards_on_ip` columns receive a
   * sensible default (null) and `rotated_at` mirrors `created_at`.
   */
  saveProxyEvent(proxy: string | null, reason: string): void {
    this.saveProxyRotation({ proxy, reason });
  }

  async saveProxyRotation(input: ProxyRotationInput): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO proxy_history
        (proxy, reason, created_at, proxy_channel, ip, rotated_at, cards_on_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.proxy ?? null,
      input.reason,
      now,
      input.proxyChannel ?? null,
      input.ip ?? null,
      input.rotatedAt ?? now,
      input.cardsOnIp ?? null
    );
  }

  async saveCaptchaEvent(input: CaptchaEventInput): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO captcha_events
        (source, url, screenshot_path, action, created_at,
         company_task_id, proxy_id, snapshot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.url ?? null,
      input.screenshotPath ?? null,
      input.action,
      now,
      input.companyTaskId ?? null,
      input.proxyId ?? null,
      input.snapshotId ?? null
    );
    return Number(result.lastInsertRowid);
  }

  // ============================================================
  // Raw snapshots (§3.7 / §3.11)
  // ============================================================

  async saveRawSnapshot(input: SaveRawSnapshotInput): Promise<number> {
    const now = new Date().toISOString();
    const payload =
      input.payload === undefined
        ? null
        : typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload);

    // When a raw snapshot directory is configured, the on-disk file is
    // authoritative for content too — we still keep the inline payload for
    // backwards compatibility with callers / tests that inspect it directly.
    // A caller-supplied `payloadPath` is always honored (it is just a label
    // pointing at a pre-existing artefact, e.g. a fixture file).
    const diskPath = input.payloadPath ?? null;

    const result = this.db.prepare(`
      INSERT INTO raw_snapshots
        (company_task_id, source, external_id, kind, purpose,
         payload, payload_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.companyTaskId ?? null,
      input.source,
      input.externalId ?? null,
      input.kind,
      input.purpose,
      payload,
      diskPath,
      now,
      now
    );
    const snapshotId = Number(result.lastInsertRowid);

    // Best-effort disk write for inline payloads. Failures must not break the
    // save — inline payload is already persisted in the row above.
    if (
      this.rawSnapshotDir !== null &&
      payload !== null &&
      diskPath === null
    ) {
      const written = this.writeSnapshotToDisk(snapshotId, input, payload, now);
      if (written !== null) {
        this.db.prepare(
          "UPDATE raw_snapshots SET payload_path = ? WHERE snapshot_id = ?"
        ).run(written, snapshotId);
      }
    }

    return snapshotId;
  }

  /**
   * Persist a snapshot payload to disk under the configured raw snapshot
   * directory. Creates the directory if it does not exist. Returns the
   * absolute file path on success, or `null` on any I/O failure (errors are
   * swallowed so the caller's DB write is never blocked by a filesystem issue).
   */
  private writeSnapshotToDisk(
    snapshotId: number,
    input: SaveRawSnapshotInput,
    payload: string,
    createdAt: string
  ): string | null {
    if (this.rawSnapshotDir === null) return null;
    try {
      fs.mkdirSync(this.rawSnapshotDir, { recursive: true });
    } catch {
      return null;
    }
    const ext = this.fileExtensionForKind(input.kind);
    const externalPart = input.externalId ?? "anon";
    const stamp = createdAt.replace(/[:.]/g, "-");
    const fileName = `snapshot-${snapshotId}-${sanitizeSegment(input.purpose)}-${sanitizeSegment(externalPart)}-${stamp}.${ext}`;
    const filePath = path.join(this.rawSnapshotDir, fileName);
    try {
      fs.writeFileSync(filePath, payload, "utf8");
      return filePath;
    } catch {
      return null;
    }
  }

  private fileExtensionForKind(kind: string): string {
    const k = kind.toLowerCase();
    if (k === "html") return "html";
    if (k === "json") return "json";
    return "txt";
  }

  /**
   * Read the payload body of a snapshot. Prefers the inline `payload` column;
   * falls back to the on-disk file referenced by `payload_path` when the
   * inline value is missing. Returns `null` if the row does not exist or the
   * payload is unavailable (e.g. disk file was deleted out-of-band).
   */
  readRawSnapshotContent(snapshotId: number): string | null {
    const row = this.getRawSnapshot(snapshotId);
    if (!row) return null;
    if (row.payload !== null) return row.payload;
    if (row.payload_path) {
      try {
        return fs.readFileSync(row.payload_path, "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }

  listRawSnapshots(filter: ListRawSnapshotsFilter = {}): RawSnapshotRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.purpose !== undefined) {
      where.push("purpose = ?");
      params.push(filter.purpose);
    }
    if (filter.source !== undefined) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.externalId !== undefined) {
      where.push("external_id = ?");
      params.push(filter.externalId);
    }
    if (filter.companyTaskId !== undefined) {
      if (filter.companyTaskId === null) {
        where.push("company_task_id IS NULL");
      } else {
        where.push("company_task_id = ?");
        params.push(filter.companyTaskId);
      }
    }
    const sql =
      "SELECT * FROM raw_snapshots" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC, snapshot_id DESC";
    return (this.db.prepare(sql).all(...params) as RawSnapshotRow[]).map((row) =>
      this.hydrateRawSnapshotPayload(row)
    );
  }

  getRawSnapshot(snapshotId: number): RawSnapshotRow | null {
    const row = this.db
      .prepare("SELECT * FROM raw_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as RawSnapshotRow | undefined;
    return row ? this.hydrateRawSnapshotPayload(row) : null;
  }

  private hydrateRawSnapshotPayload(row: RawSnapshotRow): RawSnapshotRow {
    if (row.payload !== null || !row.payload_path) return row;
    try {
      return { ...row, payload: fs.readFileSync(row.payload_path, "utf8") };
    } catch {
      return row;
    }
  }

  /**
   * Ring-buffer cleanup for `purpose='recent'` snapshots. Keeps the newest
   * `maxEntries` rows and deletes the rest. On-disk payload files referenced
   * by the deleted rows are unlinked (best-effort). Returns the number deleted.
   */
  cleanupRecentSnapshots(options: CleanupRecentOptions): number {
    if (options.maxEntries < 0) throw new Error("maxEntries must be >= 0");
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, payload_path FROM raw_snapshots
         WHERE purpose = 'recent'
           AND snapshot_id NOT IN (
             SELECT snapshot_id FROM raw_snapshots
             WHERE purpose = 'recent'
             ORDER BY created_at DESC, snapshot_id DESC
             LIMIT ?
           )`
      )
      .all(options.maxEntries) as Array<{ snapshot_id: number; payload_path: string | null }>;
    if (rows.length === 0) return 0;
    const placeholders = rows.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `DELETE FROM raw_snapshots WHERE snapshot_id IN (${placeholders})`
      )
      .run(...rows.map((r) => r.snapshot_id));
    this.unlinkPayloadFiles(rows);
    return result.changes;
  }

  /**
   * TTL cleanup. Deletes snapshots with `created_at < (now - olderThanMs)`,
   * optionally filtered by purpose. `now` can be injected for deterministic tests.
   * On-disk payload files for the deleted rows are unlinked (best-effort).
   */
  cleanupSnapshotsOlderThan(options: CleanupOlderOptions): number {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - options.olderThanMs).toISOString();
    const withPurpose = options.purpose !== undefined;
    const selectSql = withPurpose
      ? "SELECT snapshot_id, payload_path FROM raw_snapshots WHERE purpose = ? AND created_at < ?"
      : "SELECT snapshot_id, payload_path FROM raw_snapshots WHERE created_at < ?";
    const deleteSql = withPurpose
      ? "DELETE FROM raw_snapshots WHERE purpose = ? AND created_at < ?"
      : "DELETE FROM raw_snapshots WHERE created_at < ?";
    const params = withPurpose ? [options.purpose, cutoff] : [cutoff];
    const rows = this.db.prepare(selectSql).all(...params) as Array<{
      snapshot_id: number;
      payload_path: string | null;
    }>;
    const result = this.db.prepare(deleteSql).run(...params);
    this.unlinkPayloadFiles(rows);
    return result.changes;
  }

  private unlinkPayloadFiles(
    rows: Array<{ snapshot_id: number; payload_path: string | null }>
  ): void {
    for (const row of rows) {
      if (!row.payload_path) continue;
      try {
        fs.unlinkSync(row.payload_path);
      } catch {
        // Best-effort: missing or unreadable files must not break cleanup.
      }
    }
  }

  // ============================================================
  // Queue / State layer
  // ============================================================

  async createParseJob(input: CreateParseJobInput): Promise<string> {
    const id = `${input.source}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO parse_jobs (id, source, city, category, status, total_found, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', 0, ?, ?)
    `).run(id, input.source, input.city, input.category, now, now);
    return id;
  }

  async updateParseJobTotalFound(parseJobId: string, totalFound: number): Promise<void> {
    this.db.prepare(`
      UPDATE parse_jobs SET total_found = ?, updated_at = ? WHERE id = ?
    `).run(totalFound, new Date().toISOString(), parseJobId);
  }

  async setParseJobStatus(parseJobId: string, status: ParseJobStatus): Promise<void> {
    const now = new Date().toISOString();
    const finishedAt = status === "completed" || status === "failed" ? now : null;
    this.db.prepare(`
      UPDATE parse_jobs SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE id = ?
    `).run(status, now, finishedAt, parseJobId);
  }

  async getParseJob(parseJobId: string): Promise<ParseJobRow | null> {
    const row = this.db.prepare("SELECT * FROM parse_jobs WHERE id = ?").get(parseJobId) as
      | ParseJobRow
      | undefined;
    return row ?? null;
  }

  async findResumableParseJob(input: CreateParseJobInput): Promise<ParseJobRow | null> {
    const row = this.db.prepare(`
      SELECT * FROM parse_jobs
      WHERE source = ? AND city = ? AND category = ?
        AND status NOT IN ('completed', 'failed')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(input.source, input.city, input.category) as ParseJobRow | undefined;
    return row ?? null;
  }

  async finalizeParseJob(parseJobId: string): Promise<ParseJobStatus> {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('success','partial') THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status NOT IN ('success','partial','failed') THEN 1 ELSE 0 END) AS open
      FROM company_tasks
      WHERE parse_job_id = ?
    `).get(parseJobId) as { done: number | null; failed: number | null; open: number | null };

    const done = counts.done ?? 0;
    const failed = counts.failed ?? 0;
    const open = counts.open ?? 0;

    let status: ParseJobStatus;
    if (open > 0) status = "running";
    else if (done > 0) status = "completed";
    else if (failed > 0) status = "failed";
    else status = "completed";

    await this.setParseJobStatus(parseJobId, status);
    return status;
  }

  async enqueueCompanyTask(input: EnqueueCompanyTaskInput): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO company_tasks
        (parse_job_id, source, external_id, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)
    `).run(input.parseJobId, input.source, input.externalId, now, now);
    if (result.changes === 0) {
      const existing = this.db.prepare(`
        SELECT id FROM company_tasks
        WHERE source = ? AND external_id = ? AND parse_job_id = ?
      `).get(input.source, input.externalId, input.parseJobId) as { id: number };
      return existing.id;
    }
    return Number(result.lastInsertRowid);
  }

  getCompanyTask(taskId: number): CompanyTaskRow | null {
    const row = this.db.prepare("SELECT * FROM company_tasks WHERE id = ?").get(taskId) as
      | CompanyTaskRow
      | undefined;
    return row ?? null;
  }

  async listCompanyTasks(parseJobId: string): Promise<CompanyTaskRow[]> {
    return this.db
      .prepare("SELECT * FROM company_tasks WHERE parse_job_id = ? ORDER BY id ASC")
      .all(parseJobId) as CompanyTaskRow[];
  }

  async countOpenTasks(parseJobId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) as n FROM company_tasks
      WHERE parse_job_id = ?
        AND status IN ('pending', 'processing', 'retry_scheduled', 'blocked')
    `).get(parseJobId) as { n: number };
    return row.n;
  }

  async claimNextTask(input: ClaimTaskInput): Promise<CompanyTaskRow | null> {
    const txn = this.db.transaction((): CompanyTaskRow | null => {
      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + input.leaseMs).toISOString();
      const row = this.db.prepare(`
        SELECT * FROM company_tasks
        WHERE parse_job_id = ?
          AND status IN ('pending', 'retry_scheduled')
          AND (next_run_at IS NULL OR next_run_at <= ?)
        ORDER BY id ASC
        LIMIT 1
      `).get(input.parseJobId, now) as CompanyTaskRow | undefined;
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE company_tasks
        SET status = 'processing',
            worker_id = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry_scheduled')
      `).run(input.workerId, leaseUntil, now, row.id);
      if (result.changes === 0) return null;
      return {
        ...row,
        status: "processing",
        worker_id: input.workerId,
        lease_until: leaseUntil,
        attempts: row.attempts + 1,
        updated_at: now
      };
    });
    return txn.immediate();
  }

  async markTaskSuccess(taskId: number): Promise<boolean> {
    return this.transitionFromProcessing(taskId, "success", null);
  }

  async markTaskPartial(taskId: number): Promise<boolean> {
    return this.transitionFromProcessing(taskId, "partial", null);
  }

  async markTaskFailed(taskId: number, error: string): Promise<boolean> {
    return this.transitionFromProcessing(taskId, "failed", error);
  }

  async markTaskBlocked(taskId: number, error: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'blocked', last_error = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(error, now, taskId);
    return result.changes > 0;
  }

  async scheduleTaskRetry(taskId: number, error: string, nextRunAt: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'retry_scheduled',
          worker_id = NULL,
          lease_until = NULL,
          next_run_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('processing', 'blocked')
    `).run(nextRunAt, error, now, taskId);
    return result.changes > 0;
  }

  async recoverExpiredLeases(referenceTime: Date = new Date()): Promise<number> {
    const now = referenceTime.toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = 'retry_scheduled',
          worker_id = NULL,
          lease_until = NULL,
          next_run_at = ?,
          last_error = COALESCE(last_error, 'lease expired'),
          updated_at = ?
      WHERE status = 'processing'
        AND lease_until IS NOT NULL
        AND lease_until <= ?
    `).run(now, now, now);
    return result.changes;
  }

  private async transitionFromProcessing(
    taskId: number,
    status: CompanyTaskStatus,
    error: string | null
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE company_tasks
      SET status = ?,
          worker_id = NULL,
          lease_until = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ? AND status = 'processing'
    `).run(status, error, now, taskId);
    return result.changes > 0;
  }

  async getJobTelemetry(parseJobId: string): Promise<JobTelemetry> {
    return computeJobTelemetry(this.db, parseJobId);
  }

  /**
   * Count of `parse_attempts` rows linked to tasks of `parseJobId`. Used by the
   * JobManager to enforce `rateLimit.maxCardsPerSession` against the durable
   * source of truth (every attempt — success, partial, failed, blocked —
   * inserts a row in `parse_attempts`).
   */
  async countParseAttempts(parseJobId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM parse_attempts
      WHERE company_task_id IN (SELECT id FROM company_tasks WHERE parse_job_id = ?)
    `).get(parseJobId) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Replace filesystem-unsafe characters in a path segment with `_`. Keeps the
 * length bounded so we never approach platform path limits even with long
 * external identifiers.
 */
function sanitizeSegment(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}
