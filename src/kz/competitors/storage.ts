import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeTemplateText } from "./specTemplates.js";
import type {
  AnnounceGeneralParsed,
  CompetitorBid,
  CompetitorLot,
  DiscoveredLotRecord,
  LotDetailParsed,
  LotTemplateMatch,
  ParsedItogiLot,
  ProtocolLinkItem,
  StoredSpecText
} from "./types.js";

export const DEFAULT_COMPETITORS_DB_PATH = "data/competitors/competitors.db";

export interface RawLotRow {
  annoId: string;
  lotNumber: string;
  discovered: DiscoveredLotRecord;
  lotDetail: LotDetailParsed | null;
  annoGeneral: AnnounceGeneralParsed | null;
  protocols: ProtocolLinkItem[];
  techspecMeta: { fileName: string; downloadUrl: string; lotNumber: string } | null;
  needsRefresh: boolean;
  updatedAt: string;
}

export interface TechSpecSearchHit {
  specKey: string;
  annoId: string;
  lotNumber: string;
  fileName: string;
  downloadUrl: string;
  snippet: string;
}

export class CompetitorsStorage {
  readonly db: Database.Database;

  constructor(databasePath = DEFAULT_COMPETITORS_DB_PATH) {
    const resolved = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    // Portable single-file journal mode so actions/cache captures everything cleanly.
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("synchronous = NORMAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS raw_lots (
        anno_id TEXT NOT NULL,
        lot_number TEXT NOT NULL,
        discovered_json TEXT NOT NULL,
        lot_detail_json TEXT,
        anno_general_json TEXT,
        protocols_json TEXT,
        techspec_meta_json TEXT,
        needs_refresh INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (anno_id, lot_number)
      );

      CREATE TABLE IF NOT EXISTS itogi_parsed (
        anno_id TEXT PRIMARY KEY,
        protocol_url TEXT NOT NULL,
        parsed_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS techspecs (
        spec_key TEXT PRIMARY KEY,
        anno_id TEXT NOT NULL,
        lot_number TEXT NOT NULL,
        file_name TEXT NOT NULL,
        download_url TEXT NOT NULL,
        file_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        extracted_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_techspecs_anno ON techspecs(anno_id);

      CREATE TABLE IF NOT EXISTS lots (
        anno_id TEXT NOT NULL,
        lot_number TEXT NOT NULL,
        data_json TEXT NOT NULL,
        is_latest_version INTEGER NOT NULL,
        group_name TEXT NOT NULL,
        start_date TEXT NOT NULL,
        PRIMARY KEY (anno_id, lot_number)
      );

      CREATE TABLE IF NOT EXISTS bids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anno_id TEXT NOT NULL,
        lot_number TEXT NOT NULL,
        bidder_bin TEXT NOT NULL,
        is_latest_lot_version INTEGER NOT NULL,
        group_name TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bids_lot ON bids(anno_id, lot_number);

      CREATE TABLE IF NOT EXISTS template_matches (
        anno_id TEXT NOT NULL,
        lot_number TEXT NOT NULL,
        template_id TEXT NOT NULL,
        strength TEXT NOT NULL,
        share REAL NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (anno_id, lot_number, template_id)
      );
    `);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  upsertDiscoveredLots(records: readonly DiscoveredLotRecord[], markChangedRefresh = true): { inserted: number; changed: number } {
    const now = new Date().toISOString();
    const selectStmt = this.db.prepare("SELECT discovered_json, needs_refresh FROM raw_lots WHERE anno_id = ? AND lot_number = ?");
    const insertStmt = this.db.prepare(`
      INSERT INTO raw_lots (anno_id, lot_number, discovered_json, needs_refresh, updated_at)
      VALUES (?, ?, ?, 1, ?)
    `);
    const updateStmt = this.db.prepare(`
      UPDATE raw_lots SET discovered_json = ?, needs_refresh = ?, updated_at = ?
      WHERE anno_id = ? AND lot_number = ?
    `);

    let inserted = 0;
    let changed = 0;
    const tx = this.db.transaction((rows: readonly DiscoveredLotRecord[]) => {
      for (const rec of rows) {
        const existing = selectStmt.get(rec.annoId, rec.lotNumber) as { discovered_json: string; needs_refresh: number } | undefined;
        if (!existing) {
          insertStmt.run(rec.annoId, rec.lotNumber, JSON.stringify(rec), now);
          inserted++;
          continue;
        }
        const prev = JSON.parse(existing.discovered_json) as DiscoveredLotRecord;
        const mergedCodes = [...new Set([...(prev.enstruCodesMatched ?? [prev.enstruCode].filter(Boolean) as string[]), ...(rec.enstruCodesMatched ?? [rec.enstruCode].filter(Boolean) as string[])])];
        const nextRec: DiscoveredLotRecord = { ...prev, ...rec, enstruCodesMatched: mergedCodes };
        const statusChanged = prev.statusSearch !== nextRec.statusSearch;
        const needsRefresh = existing.needs_refresh || (markChangedRefresh && statusChanged) ? 1 : 0;
        if (statusChanged) changed++;
        updateStmt.run(JSON.stringify(nextRec), needsRefresh, now, rec.annoId, rec.lotNumber);
      }
    });
    tx(records);
    return { inserted, changed };
  }

  loadAllRawLots(): RawLotRow[] {
    const rows = this.db.prepare("SELECT * FROM raw_lots").all() as Array<{
      anno_id: string;
      lot_number: string;
      discovered_json: string;
      lot_detail_json: string | null;
      anno_general_json: string | null;
      protocols_json: string | null;
      techspec_meta_json: string | null;
      needs_refresh: number;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      annoId: r.anno_id,
      lotNumber: r.lot_number,
      discovered: JSON.parse(r.discovered_json) as DiscoveredLotRecord,
      lotDetail: r.lot_detail_json ? (JSON.parse(r.lot_detail_json) as LotDetailParsed) : null,
      annoGeneral: r.anno_general_json ? (JSON.parse(r.anno_general_json) as AnnounceGeneralParsed) : null,
      protocols: r.protocols_json ? (JSON.parse(r.protocols_json) as ProtocolLinkItem[]) : [],
      techspecMeta: r.techspec_meta_json
        ? (JSON.parse(r.techspec_meta_json) as { fileName: string; downloadUrl: string; lotNumber: string })
        : null,
      needsRefresh: r.needs_refresh === 1,
      updatedAt: r.updated_at
    }));
  }

  saveLotEnrichment(
    annoId: string,
    lotNumber: string,
    patch: {
      lotDetail?: LotDetailParsed | null;
      annoGeneral?: AnnounceGeneralParsed | null;
      protocols?: ProtocolLinkItem[];
      techspecMeta?: { fileName: string; downloadUrl: string; lotNumber: string } | null;
      needsRefresh?: boolean;
    }
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];
    if (patch.lotDetail !== undefined) {
      sets.push("lot_detail_json = ?");
      params.push(patch.lotDetail ? JSON.stringify(patch.lotDetail) : null);
    }
    if (patch.annoGeneral !== undefined) {
      sets.push("anno_general_json = ?");
      params.push(patch.annoGeneral ? JSON.stringify(patch.annoGeneral) : null);
    }
    if (patch.protocols !== undefined) {
      sets.push("protocols_json = ?");
      params.push(JSON.stringify(patch.protocols));
    }
    if (patch.techspecMeta !== undefined) {
      sets.push("techspec_meta_json = ?");
      params.push(patch.techspecMeta ? JSON.stringify(patch.techspecMeta) : null);
    }
    if (patch.needsRefresh !== undefined) {
      sets.push("needs_refresh = ?");
      params.push(patch.needsRefresh ? 1 : 0);
    }
    params.push(annoId, lotNumber);
    this.db.prepare(`UPDATE raw_lots SET ${sets.join(", ")} WHERE anno_id = ? AND lot_number = ?`).run(...params);
  }

  markNeedsRefresh(annoId: string, lotNumber: string, needsRefresh: boolean): void {
    this.db.prepare("UPDATE raw_lots SET needs_refresh = ? WHERE anno_id = ? AND lot_number = ?").run(needsRefresh ? 1 : 0, annoId, lotNumber);
  }

  getItogiParsed(annoId: string): { protocolUrl: string; parsed: Record<string, ParsedItogiLot> } | null {
    const row = this.db.prepare("SELECT protocol_url, parsed_json FROM itogi_parsed WHERE anno_id = ?").get(annoId) as
      | { protocol_url: string; parsed_json: string }
      | undefined;
    if (!row) return null;
    return { protocolUrl: row.protocol_url, parsed: JSON.parse(row.parsed_json) as Record<string, ParsedItogiLot> };
  }

  saveItogiParsed(annoId: string, protocolUrl: string, parsed: Record<string, ParsedItogiLot>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO itogi_parsed (anno_id, protocol_url, parsed_json, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(anno_id) DO UPDATE SET protocol_url = excluded.protocol_url, parsed_json = excluded.parsed_json, fetched_at = excluded.fetched_at`
      )
      .run(annoId, protocolUrl, JSON.stringify(parsed), now);
  }

  getTechSpec(specKey: string): StoredSpecText | null {
    const row = this.db.prepare("SELECT * FROM techspecs WHERE spec_key = ?").get(specKey) as
      | {
          spec_key: string;
          anno_id: string;
          lot_number: string;
          file_name: string;
          download_url: string;
          file_kind: string;
          text: string;
          normalized_text: string;
          extracted_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      specKey: row.spec_key,
      annoId: row.anno_id,
      lotNumber: row.lot_number,
      fileName: row.file_name,
      downloadUrl: row.download_url,
      fileKind: row.file_kind,
      text: row.text,
      normalizedText: row.normalized_text,
      extractedAt: row.extracted_at
    };
  }

  getTechSpecsForAnno(annoId: string): StoredSpecText[] {
    const rows = this.db.prepare("SELECT * FROM techspecs WHERE anno_id = ?").all(annoId) as Array<{
      spec_key: string;
      anno_id: string;
      lot_number: string;
      file_name: string;
      download_url: string;
      file_kind: string;
      text: string;
      normalized_text: string;
      extracted_at: string;
    }>;
    return rows.map((row) => ({
      specKey: row.spec_key,
      annoId: row.anno_id,
      lotNumber: row.lot_number,
      fileName: row.file_name,
      downloadUrl: row.download_url,
      fileKind: row.file_kind,
      text: row.text,
      normalizedText: row.normalized_text,
      extractedAt: row.extracted_at
    }));
  }

  saveTechSpec(spec: StoredSpecText): void {
    this.db
      .prepare(
        `INSERT INTO techspecs (spec_key, anno_id, lot_number, file_name, download_url, file_kind, text, normalized_text, extracted_at)
         VALUES (@specKey, @annoId, @lotNumber, @fileName, @downloadUrl, @fileKind, @text, @normalizedText, @extractedAt)
         ON CONFLICT(spec_key) DO UPDATE SET
           anno_id = excluded.anno_id,
           lot_number = excluded.lot_number,
           file_name = excluded.file_name,
           download_url = excluded.download_url,
           file_kind = excluded.file_kind,
           text = excluded.text,
           normalized_text = excluded.normalized_text,
           extracted_at = excluded.extracted_at`
      )
      .run(spec);
  }

  /**
   * Stage 3 foundation: searches stored techspecs by a normalized text snippet.
   */
  searchTechSpecs(snippet: string, limit = 20): TechSpecSearchHit[] {
    const norm = normalizeTemplateText(snippet);
    if (!norm) return [];
    const escaped = norm.replace(/[%_\\]/g, "\\$&");
    const rows = this.db
      .prepare(
        `SELECT spec_key, anno_id, lot_number, file_name, download_url, text, normalized_text
         FROM techspecs
         WHERE normalized_text LIKE ? ESCAPE '\\'
         LIMIT ?`
      )
      .all(`%${escaped}%`, limit) as Array<{
      spec_key: string;
      anno_id: string;
      lot_number: string;
      file_name: string;
      download_url: string;
      text: string;
      normalized_text: string;
    }>;

    return rows.map((r) => {
      const idx = r.normalized_text.indexOf(norm);
      const start = Math.max(0, idx - 60);
      const snippetOut = r.normalized_text.slice(start, start + norm.length + 140);
      return {
        specKey: r.spec_key,
        annoId: r.anno_id,
        lotNumber: r.lot_number,
        fileName: r.file_name,
        downloadUrl: r.download_url,
        snippet: snippetOut
      };
    });
  }

  replaceNormalizedData(
    lots: readonly CompetitorLot[],
    bids: readonly CompetitorBid[],
    templateMatches: readonly LotTemplateMatch[]
  ): void {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM lots; DELETE FROM bids; DELETE FROM template_matches;");
      const insertLot = this.db.prepare(
        "INSERT INTO lots (anno_id, lot_number, data_json, is_latest_version, group_name, start_date) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const l of lots) {
        insertLot.run(l.annoId, l.lotNumber, JSON.stringify(l), l.isLatestVersion ? 1 : 0, l.group, l.startDate);
      }

      const insertBid = this.db.prepare(
        "INSERT INTO bids (anno_id, lot_number, bidder_bin, is_latest_lot_version, group_name, data_json) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const b of bids) {
        insertBid.run(b.annoId, b.lotNumber, b.bidderBin, b.isLatestLotVersion ? 1 : 0, b.group, JSON.stringify(b));
      }

      const insertMatch = this.db.prepare(
        "INSERT INTO template_matches (anno_id, lot_number, template_id, strength, share, data_json) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const m of templateMatches) {
        insertMatch.run(m.annoId, m.lotNumber, m.templateId, m.strength, m.share, JSON.stringify(m));
      }
    });
    tx();
  }

  loadLots(onlyLatest = true): CompetitorLot[] {
    const sql = onlyLatest ? "SELECT data_json FROM lots WHERE is_latest_version = 1" : "SELECT data_json FROM lots";
    const rows = this.db.prepare(sql).all() as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as CompetitorLot);
  }

  loadBids(onlyLatest = true): CompetitorBid[] {
    const sql = onlyLatest ? "SELECT data_json FROM bids WHERE is_latest_lot_version = 1" : "SELECT data_json FROM bids";
    const rows = this.db.prepare(sql).all() as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as CompetitorBid);
  }

  loadTemplateMatches(): LotTemplateMatch[] {
    const rows = this.db.prepare("SELECT data_json FROM template_matches").all() as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as LotTemplateMatch);
  }

  close(): void {
    this.db.close();
  }
}
