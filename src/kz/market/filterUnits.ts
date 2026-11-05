import type { MarketConfig, MarketUnit } from "./types.js";
import {
  classifyCode,
  marketMinUnitPrice,
  isExcludedStatus,
  getMethodName,
  cleanEntityName,
  loadMarketConfig,
  requiresTextFilter
} from "./config.js";

export interface RawContractUnit {
  refEnstruCode?: string | string[];
  quantity?: number | null;
  itemPrice?: number | null;
  totalSum?: number | null;
  text?: string | null;
  plan_item?: {
    name_ru?: string | null;
    extra_description_ru?: string | null;
    extra_description_kk?: string | null;
  } | null;
  Plans?: {
    nameRu?: string | null;
    extraDescRu?: string | null;
    extraDescKz?: string | null;
  } | null;
}

export function extractUnitText(u: RawContractUnit): string {
  if (u.text) return u.text;
  const parts: (string | null | undefined)[] = [];
  if (u.plan_item) {
    parts.push(u.plan_item.name_ru, u.plan_item.extra_description_ru, u.plan_item.extra_description_kk);
  }
  if (u.Plans) {
    parts.push(u.Plans.nameRu, u.Plans.extraDescRu, u.Plans.extraDescKz);
  }
  return parts.filter((v): v is string => Boolean(v && typeof v === "string" && v.trim())).join(" ");
}

export interface FilterContractUnitsOptions {
  onSkippedLcdWithoutText?: (count: number) => void;
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
  cfg: MarketConfig = loadMarketConfig(),
  options?: FilterContractUnitsOptions
): MarketUnit[] {
  const units: MarketUnit[] = [];
  const ourBinsSet = new Set<string>();
  if (cfg.ourBins && cfg.ourBins.length > 0) {
    for (const b of cfg.ourBins) {
      ourBinsSet.add(typeof b === "string" ? b : b.bin);
    }
  } else if (cfg.bin) {
    ourBinsSet.add(cfg.bin);
  }

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
    const isUs = ourBinsSet.has(supplierBin);

    const rawUnits = c.ContractUnits ?? [];
    for (const [unitIdx, u] of rawUnits.entries()) {
      const codes = Array.isArray(u.refEnstruCode)
        ? u.refEnstruCode
        : u.refEnstruCode
        ? [u.refEnstruCode]
        : [];

      const unitText = extractUnitText(u);
      let classification: { group: "ИП" | "КТ"; kind: string } | null = null;
      let matchedCode = "";
      for (const code of codes) {
        classification = classifyCode(code, cfg, unitText);
        if (classification) {
          matchedCode = code;
          break;
        }
      }

      if (!classification) {
        const needsText = codes.some((code) => requiresTextFilter(code, cfg));
        const price = Number(u.itemPrice ?? 0);
        if (needsText && !unitText.trim() && price >= cfg.minUnitPrice) {
          options?.onSkippedLcdWithoutText?.(1);
        }
        continue;
      }

      const price = Number(u.itemPrice ?? 0);
      if (price < marketMinUnitPrice(matchedCode, cfg)) continue;

      const qty = Number(u.quantity ?? 0);
      const sum = Number(u.totalSum != null ? u.totalSum : price * qty);

      units.push({
        id: c.id,
        unitIndex: unitIdx,
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
