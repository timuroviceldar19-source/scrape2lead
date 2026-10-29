import type { MarketConfig, MarketUnit } from "./types.js";
import {
  classifyCode,
  isExcludedStatus,
  getMethodName,
  cleanEntityName,
  loadMarketConfig
} from "./config.js";

export interface RawContractUnit {
  refEnstruCode?: string | string[];
  quantity?: number | null;
  itemPrice?: number | null;
  totalSum?: number | null;
}

export interface RawContractItem {
  id: number;
  signDate?: string | null;
  contractSum?: number | null;
  faktTradeMethodsId?: number | null;
  refContractStatusId?: number | null;
  supplierBiin?: string | null;
  customerBin?: string | null;
  Supplier?: { nameRu?: string | null } | null;
  Customer?: { nameRu?: string | null } | null;
  ContractUnits?: RawContractUnit[] | null;
}

export function filterContractUnits(
  contracts: RawContractItem[],
  cfg: MarketConfig = loadMarketConfig()
): MarketUnit[] {
  const units: MarketUnit[] = [];

  for (const c of contracts) {
    if (!c.signDate || !c.refContractStatusId) continue;
    if (isExcludedStatus(c.refContractStatusId, cfg)) continue;

    const dateStr = String(c.signDate).slice(0, 10);
    const monthStr = dateStr.slice(0, 7);
    const supplierBin = String(c.supplierBiin ?? "").trim();
    const customerBin = String(c.customerBin ?? "").trim();
    const supplierName = cleanEntityName(c.Supplier?.nameRu) || supplierBin;
    const customerName = cleanEntityName(c.Customer?.nameRu) || customerBin;
    const method = getMethodName(c.faktTradeMethodsId ?? 0, cfg);
    const isUs = supplierBin === cfg.bin;

    const rawUnits = c.ContractUnits ?? [];
    for (const u of rawUnits) {
      const codes = Array.isArray(u.refEnstruCode)
        ? u.refEnstruCode
        : u.refEnstruCode
        ? [u.refEnstruCode]
        : [];

      let classification: { group: "ИП" | "КТ"; kind: string } | null = null;
      let matchedCode = "";
      for (const code of codes) {
        classification = classifyCode(code, cfg);
        if (classification) {
          matchedCode = code;
          break;
        }
      }

      if (!classification) continue;

      const price = Number(u.itemPrice ?? 0);
      if (price < cfg.minUnitPrice) continue;

      const qty = Number(u.quantity ?? 0);
      const sum = Number(u.totalSum != null ? u.totalSum : price * qty);

      units.push({
        id: c.id,
        month: monthStr,
        date: dateStr,
        group: classification.group,
        code: matchedCode,
        kind: classification.kind,
        sum,
        qty,
        price,
        supplier: supplierBin,
        customer: customerBin,
        supplierName,
        customerName,
        method,
        us: isUs
      });
    }
  }

  return units;
}
