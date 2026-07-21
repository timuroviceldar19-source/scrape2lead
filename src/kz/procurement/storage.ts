import type Database from "better-sqlite3";
import { runMigrations } from "../../storage/migrations.js";
import type { ProcurementRecord } from "./types.js";

export class ProcurementStorage {
  constructor(private readonly options: { db: Database.Database }) { runMigrations(options.db); }

  upsert(record: ProcurementRecord): void {
    this.options.db.prepare(`
      INSERT INTO procurement_records (
        source, record_kind, external_id, parent_external_id, status, product_name, description,
        tru_code, customer_name, customer_bin, amount, currency, start_date, end_date, url,
        purchase_method, collected_at
      ) VALUES (
        @source, @recordKind, @externalId, @parentExternalId, @status, @productName, @description,
        @truCode, @customerName, @customerBin, @amount, @currency, @startDate, @endDate, @url,
        @purchaseMethod, @collectedAt
      )
      ON CONFLICT(source, record_kind, external_id) DO UPDATE SET
        parent_external_id=excluded.parent_external_id, status=excluded.status,
        product_name=excluded.product_name, description=excluded.description, tru_code=excluded.tru_code,
        customer_name=excluded.customer_name, customer_bin=excluded.customer_bin, amount=excluded.amount,
        currency=excluded.currency, start_date=excluded.start_date, end_date=excluded.end_date,
        url=excluded.url, purchase_method=excluded.purchase_method, collected_at=excluded.collected_at
    `).run(record);
  }

  list(): ProcurementRecord[] {
    const rows = this.options.db.prepare("SELECT * FROM procurement_records ORDER BY source, record_kind, external_id").all() as Record<string, unknown>[];
    return rows.map(mapRow);
  }
}

function mapRow(row: Record<string, unknown>): ProcurementRecord {
  return {
    source: String(row.source) as ProcurementRecord["source"], recordKind: String(row.record_kind) as ProcurementRecord["recordKind"],
    externalId: String(row.external_id), parentExternalId: nullable(row.parent_external_id), status: nullable(row.status),
    productName: String(row.product_name), description: String(row.description), truCode: nullable(row.tru_code),
    customerName: nullable(row.customer_name), customerBin: nullable(row.customer_bin), amount: Number(row.amount),
    currency: String(row.currency), startDate: nullable(row.start_date), endDate: nullable(row.end_date), url: String(row.url),
    purchaseMethod: nullable(row.purchase_method), collectedAt: String(row.collected_at)
  };
}
function nullable(value: unknown): string | null { return value === null || value === undefined || value === "" ? null : String(value); }
