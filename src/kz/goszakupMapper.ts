import type { TenderRecord } from "./tenderTypes.js";
import type { GoszakupRawItem } from "./goszakupClient.js";
import { resolveBuyStatusName } from "./goszakupStatus.js";

export interface GoszakupMapContext {
  bin: string;
  statusMap: Map<number, string>;
}

export function mapGoszakupTender(
  item: GoszakupRawItem,
  ctx: GoszakupMapContext
): TenderRecord | null {
  const orgBin = item.org_bin != null ? String(item.org_bin) : null;
  if (orgBin && orgBin !== ctx.bin) {
    console.debug(`goszakup.gov.kz: skip item ${item.id} — org_bin ${orgBin} ≠ requested ${ctx.bin}`);
    return null;
  }

  const id = item.id != null ? String(item.id) : null;
  const number = item.number_anno || id || "N/A";
  const statusId = item.ref_buy_status_id != null ? Number(item.ref_buy_status_id) : null;
  const statusName = statusId != null ? resolveBuyStatusName(statusId, ctx.statusMap) : null;

  const customerId = item.customer_name_ru || item.customer_name_kz;
  const orgId = item.org_name_ru || item.org_name_kz;
  const customerFallback = customerId || orgId || null;

  return {
    source: "goszakup.gov.kz",
    bin: ctx.bin,
    tender_number: number,
    tender_name: item.name_ru || item.name_kz || "N/A",
    customer_name: customerFallback,
    budget_amount: item.total_sum != null ? String(item.total_sum) : null,
    currency: "KZT",
    start_date: item.start_date || null,
    end_date: item.end_date || null,
    status: statusName,
    method: item.ref_trade_methods_id != null ? String(item.ref_trade_methods_id) : null,
    url: `https://goszakup.gov.kz/ru/trd-buy/${id || number}`,
    parsed_at: new Date().toISOString()
  };
}
