import type { ClassifiedProcurement, ProcurementClassification } from "./types.js";

export interface ProcurementWorkbookSheet { name: "Data" | "Review" | "Rejected" | "Summary"; rows: Array<Array<string | number | null>> }
export interface ProcurementWorkbookModel { sheets: ProcurementWorkbookSheet[]; summary: { total: number; data: number; review: number; rejected: number } }

const HEADERS = ["Source", "Kind", "External ID", "Parent ID", "Product", "Reason", "Status", "Name", "Description",
  "TRU code", "Customer", "BIN", "Amount", "Currency", "Start", "End", "Method", "URL", "Collected at"];

export function buildProcurementWorkbookModel(input: ProcurementClassification): ProcurementWorkbookModel {
  const summary = { total: input.data.length + input.review.length + input.rejected.length,
    data: input.data.length, review: input.review.length, rejected: input.rejected.length };
  const reasons = new Map<string, number>();
  for (const item of [...input.review, ...input.rejected]) {
    const reason = item.reason ?? "unknown";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return { sheets: [
    { name: "Data", rows: [HEADERS, ...input.data.map(toRow)] },
    { name: "Review", rows: [HEADERS, ...input.review.map(toRow)] },
    { name: "Rejected", rows: [HEADERS, ...input.rejected.map(toRow)] },
    { name: "Summary", rows: [["Metric", "Count"], ["total", summary.total], ["data", summary.data],
      ["review", summary.review], ["rejected", summary.rejected], ...[...reasons.entries()].sort(([a], [b]) => a.localeCompare(b))] }
  ], summary };
}

function toRow(item: ClassifiedProcurement): Array<string | number | null> {
  const row = item.record;
  return [row.source, row.recordKind, row.externalId, row.parentExternalId, item.product, item.reason, row.status,
    row.productName, row.description, row.truCode, row.customerName, row.customerBin, row.amount, row.currency,
    row.startDate, row.endDate, row.purchaseMethod, row.url, row.collectedAt];
}
