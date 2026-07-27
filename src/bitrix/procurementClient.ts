import { BitrixClient } from "./client.js";
import type { ProcurementPushClient } from "./procurementPush.js";
import type { ExistingProcurementDeal } from "./procurementDealPlan.js";
import type { ProcurementRecord } from "../kz/procurement/types.js";

export class ProcurementBitrixClient implements ProcurementPushClient {
  constructor(private readonly client: BitrixClient) {}

  async findByOrigin(originatorId: string, originId: string): Promise<ExistingProcurementDeal | null> {
    // BEGINDATE нужен, чтобы понять, несёт ли карточка ложную дату, оставшуюся от прежней схемы.
    const row = await this.client.findFirst("deal", { ORIGINATOR_ID: originatorId, ORIGIN_ID: originId },
      ["ID", "CATEGORY_ID", "STAGE_ID", "ASSIGNED_BY_ID", "BEGINDATE"]);
    return row?.ID === undefined ? null : toExistingDeal(row);
  }

  async findPotentialDuplicate(record: ProcurementRecord): Promise<ExistingProcurementDeal | null> {
    const select = ["ID", "TITLE", "COMMENTS", "ORIGIN_ID", "CATEGORY_ID", "STAGE_ID", "ASSIGNED_BY_ID", "BEGINDATE"];
    let rows: Record<string, unknown>[];
    try {
      rows = await this.client.listAll("deal", { "=OPPORTUNITY": record.amount }, select, 4);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("result exceeds")) throw error;
      rows = await this.findNarrowCandidates(record, select);
    }
    const externalId = normalize(record.externalId);
    const customerBin = normalize(record.customerBin ?? "");
    const targetTitle = normalize(`${record.customerName ?? ""} ${record.productName}`);
    for (const row of rows) {
      const combined = normalize(`${row.TITLE ?? ""} ${row.COMMENTS ?? ""} ${row.ORIGIN_ID ?? ""}`);
      const sameExternalId = externalId.length >= 4 && combined.includes(externalId);
      const sameBin = customerBin.length === 12 && combined.includes(customerBin);
      const similarTitle = tokenSimilarity(targetTitle, normalize(String(row.TITLE ?? ""))) >= 0.5;
      if ((sameExternalId || (sameBin && similarTitle)) && row.ID !== undefined) return toExistingDeal(row);
    }
    return null;
  }

  private async findNarrowCandidates(record: ProcurementRecord, select: string[]): Promise<Record<string, unknown>[]> {
    const filters: Record<string, unknown>[] = [
      { "=OPPORTUNITY": record.amount, "%TITLE": record.externalId },
      { "=OPPORTUNITY": record.amount, "%COMMENTS": record.externalId }
    ];
    if (record.customerBin) filters.push(
      { "=OPPORTUNITY": record.amount, "%COMMENTS": record.customerBin },
      { "=OPPORTUNITY": record.amount, "%TITLE": record.customerBin }
    );
    const unique = new Map<string, Record<string, unknown>>();
    for (const filter of filters) {
      const rows = await this.client.listAll("deal", filter, select, 4);
      for (const row of rows) unique.set(String(row.ID ?? JSON.stringify(row)), row);
    }
    return [...unique.values()];
  }

  async addDeal(fields: Record<string, unknown>): Promise<string> { return await this.client.add("deal", fields); }
  async updateDeal(id: string, fields: Record<string, unknown>): Promise<void> { await this.client.update("deal", id, fields); }
}

function toExistingDeal(row: Record<string, unknown>): ExistingProcurementDeal {
  return { ID: String(row.ID), CATEGORY_ID: scalar(row.CATEGORY_ID), STAGE_ID: textScalar(row.STAGE_ID),
    ASSIGNED_BY_ID: scalar(row.ASSIGNED_BY_ID), BEGINDATE: textScalar(row.BEGINDATE) };
}
function textScalar(value: unknown): string | null { return value === undefined || value === null ? null : String(value); }
function scalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function tokenSimilarity(left: string, right: string): number {
  const a = new Set(left.split(" ").filter((token) => token.length > 2));
  const b = new Set(right.split(" ").filter((token) => token.length > 2));
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((token) => b.has(token)).length;
  return common / Math.min(a.size, b.size);
}
