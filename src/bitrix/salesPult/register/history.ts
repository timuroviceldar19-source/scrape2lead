import { zakupListAll, zakupGet, type ZakupPage, type ZakupApiOptions } from "../../../kz/zakupPublicApi.js";
import type { MarketConfig } from "../../../kz/market/types.js";
import { isExcludedStatus, loadMarketConfig } from "../../../kz/market/config.js";
import fs from "node:fs";
import path from "node:path";
import { parseRegisterExcel } from "./parseExcel.js";
import { groupRegisterContracts, calculateNameSimilarity, matchRegisterWithCrm } from "./matchCrm.js";
import { compareRegisterFiles, getFileRevision } from "./diskClient.js";
import { getNextMonth } from "./fetchCrmWon.js";

interface ZakupDictItem {
  id: number;
  egz_code?: string | number;
  [key: string]: unknown;
}
import type {
  RegisterRow,
  RegisterContract,
  RegisterMonthSummary,
  RegisterPortalMissingContract,
  RegisterPortalReconciliationView,
  RegisterDisciplineView,
  RegisterDisciplineRetroChange,
  RegisterHistoryPayload,
  CrmWonDeal
} from "./types.js";
import {
  DEFAULT_REGISTER_CACHE_DIR,
  DEFAULT_REGISTER_HISTORY_PATH,
  loadEncryptedRegisterHistory,
  saveEncryptedRegisterHistory
} from "./crypto.js";

export { DEFAULT_REGISTER_CACHE_DIR, DEFAULT_REGISTER_HISTORY_PATH, getFileRevision };

export interface PortalContractInput {
  id: number | string;
  contract_number?: string;
  sign_date?: string;
  status_id?: number | string;
  customer_organization_name?: string;
  contract_price_with_vat?: number;
  purchase_method_name?: string;
  supplier?: string;
  supplier_organization_id?: number | string;
  supplier_organization_bin?: string;
}

const MONTH_NAMES_RU: Record<string, string> = {
  "01": "Январь",
  "02": "Февраль",
  "03": "Март",
  "04": "Апрель",
  "05": "Май",
  "06": "Июнь",
  "07": "Июль",
  "08": "Август",
  "09": "Сентябрь",
  "10": "Октябрь",
  "11": "Ноябрь",
  "12": "Декабрь"
};

export function getLastDayOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yearMonth}-${String(d).padStart(2, "0")}`;
}

export function getPrevMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const prevDate = new Date(Date.UTC(y, m - 2, 1));
  const py = prevDate.getUTCFullYear();
  const pm = String(prevDate.getUTCMonth() + 1).padStart(2, "0");
  return `${py}-${pm}`;
}

export function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split("-");
  const name = MONTH_NAMES_RU[m] || m;
  return `${name} ${y}`;
}

export function buildRegisterMonthSummary(params: {
  month: string;
  label?: string;
  fileName: string;
  rows: RegisterRow[];
  plans: Record<string, number>;
  hasValColumn?: boolean;
}): RegisterMonthSummary {
  const { month, fileName, rows, plans } = params;
  const label = params.label || formatMonthLabel(month);
  const hasVal = params.hasValColumn ?? (rows.length === 0 || rows.some((r) => r.val !== null));

  const contracts = groupRegisterContracts(rows);
  const totalSale = rows.reduce((s, r) => s + r.sale, 0);
  const totalVal = hasVal ? rows.reduce((s, r) => s + (r.val || 0), 0) : null;
  const margin = hasVal && totalSale > 0 && totalVal !== null ? totalVal / totalSale : null;
  const plan = Object.values(plans).reduce((s, p) => s + p, 0);
  const planPct = plan > 0 ? (totalSale / plan) * 100 : null;

  // By Manager breakdown
  const allManagers = new Set<string>([
    ...Object.keys(plans).filter((m) => m !== "B2B"),
    ...rows.map((r) => r.manager)
  ]);

  const byManager = Array.from(allManagers)
    .map((name) => {
      const ownRows = rows.filter((r) => r.manager === name);
      const mSale = ownRows.reduce((s, r) => s + r.sale, 0);
      const mVal = hasVal ? ownRows.reduce((s, r) => s + (r.val || 0), 0) : null;
      const mMargin = hasVal && mSale > 0 && mVal !== null ? mVal / mSale : null;
      const mContracts = groupRegisterContracts(ownRows).length;
      const mPlan = plans[name] || 0;
      const mPlanPct = mPlan > 0 ? (mSale / mPlan) * 100 : null;

      return {
        name,
        sale: mSale,
        val: mVal,
        margin: mMargin,
        contracts: mContracts,
        plan: mPlan,
        planPct: mPlanPct
      };
    })
    .sort((a, b) => b.sale - a.sale);

  return {
    month,
    label,
    fileName,
    sale: totalSale,
    val: totalVal,
    margin,
    contracts: contracts.length,
    plan,
    planPct,
    hasVal,
    byManager
  };
}

/**
 * Strict 1-to-1 matching between portal contracts and register contracts:
 * - Customer name similarity >= 0.25
 * - Same or adjacent month (month difference <= 1)
 * - Amount strictly within 3% tolerance (against x1, x1.12, x1.16). Pairs without amount match within 3% are NEVER accepted.
 * - Prioritized by smallest amount deviation, then smallest date diff, then name similarity.
 */
export function matchPortalContracts1to1(
  portalContracts: PortalContractInput[],
  registerInput: RegisterRow[] | RegisterContract[]
): {
  matchedCount: number;
  matched1to1Count: number;
  matchedByCustomerSumCount: number;
  matchedPairs: Array<{ portal: PortalContractInput; registerKey: string }>;
  matchedByCustomerSumPairs: Array<{
    portalIds: Array<number | string>;
    registerKeys: string[];
    customer: string;
  }>;
  missingContracts: RegisterPortalMissingContract[];
} {
  const contracts: RegisterContract[] =
    registerInput.length > 0 && "products" in registerInput[0]
      ? (registerInput as RegisterContract[])
      : groupRegisterContracts(registerInput as RegisterRow[]);

  interface CandidatePair {
    portal: PortalContractInput;
    registerContract: RegisterContract;
    registerKey: string;
    minDev: number;
    dateDiffDays: number;
    sim: number;
  }

  const usedPortalIds = new Set<string | number>();
  const usedRegisterKeys = new Set<string>();
  const matchedPairs: Array<{ portal: PortalContractInput; registerKey: string }> = [];

  function find1to1CandidatePairs(requiredMonthDiff: number): CandidatePair[] {
    const pairs: CandidatePair[] = [];
    for (const pc of portalContracts) {
      if (usedPortalIds.has(pc.id)) continue;
      const pcPrice = pc.contract_price_with_vat || 0;
      if (pcPrice <= 0) continue;
      const pcDate = pc.sign_date || "";
      const pcMonth = pcDate.slice(0, 7);

      for (const rc of contracts) {
        if (rc.sale <= 0) continue;
        const rcKey = `${rc.date}|${rc.customer}|${rc.manager}|${rc.sale}`;
        if (usedRegisterKeys.has(rcKey)) continue;

        const rcDate = rc.date || "";
        const rcMonth = rcDate.slice(0, 7);

        // Month diff check: exact match with requiredMonthDiff (0 for same month, 1 for adjacent)
        if (pcMonth && rcMonth) {
          const [y1, m1] = pcMonth.split("-").map(Number);
          const [y2, m2] = rcMonth.split("-").map(Number);
          const monthDiff = Math.abs((y1 - y2) * 12 + (m1 - m2));
          if (monthDiff !== requiredMonthDiff) continue;
        } else if (requiredMonthDiff !== 0) {
          continue;
        }

        // Customer name similarity check (>= 0.5)
        const sim = calculateNameSimilarity(pc.customer_organization_name || "", rc.customer);
        if (sim < 0.5) continue;

        // Amount tolerance check: strictly <= 3% (0.03) against x1, x1.12, x1.16
        const rRaw = pcPrice / rc.sale;
        const r12 = pcPrice / (rc.sale * 1.12);
        const r16 = pcPrice / (rc.sale * 1.16);

        const devRaw = Math.abs(rRaw - 1);
        const dev12 = Math.abs(r12 - 1);
        const dev16 = Math.abs(r16 - 1);

        const validDevs = [devRaw, dev12, dev16].filter((d) => d <= 0.03);
        if (validDevs.length === 0) {
          continue;
        }

        const minDev = Math.min(...validDevs);
        const dateDiffDays =
          pcDate && rcDate
            ? Math.abs((Date.parse(pcDate) - Date.parse(rcDate)) / 86_400_000)
            : 999;

        pairs.push({
          portal: pc,
          registerContract: rc,
          registerKey: rcKey,
          minDev,
          dateDiffDays,
          sim
        });
      }
    }

    pairs.sort((a, b) => {
      if (Math.abs(a.minDev - b.minDev) > 0.0001) {
        return a.minDev - b.minDev;
      }
      if (a.dateDiffDays !== b.dateDiffDays) {
        return a.dateDiffDays - b.dateDiffDays;
      }
      return b.sim - a.sim;
    });

    return pairs;
  }

  function applyCandidatePairs(pairs: CandidatePair[]): void {
    for (const cand of pairs) {
      if (usedPortalIds.has(cand.portal.id)) continue;
      if (usedRegisterKeys.has(cand.registerKey)) continue;

      usedPortalIds.add(cand.portal.id);
      usedRegisterKeys.add(cand.registerKey);
      matchedPairs.push({ portal: cand.portal, registerKey: cand.registerKey });
    }
  }

  // Pass 1: 1-to-1 in the same month (monthDiff === 0)
  const pass1Pairs = find1to1CandidatePairs(0);
  applyCandidatePairs(pass1Pairs);

  let matchedByCustomerSumCount = 0;
  const matchedByCustomerSumPairs: Array<{
    portalIds: Array<number | string>;
    registerKeys: string[];
    customer: string;
  }> = [];

  // Pass 2: Second pass on remaining contracts of the same customer within 14 days
  const remainingPortal = portalContracts.filter(
    (pc) => !usedPortalIds.has(pc.id) && (pc.contract_price_with_vat || 0) > 0
  );
  const remainingRegister = contracts.filter((rc) => {
    const rcKey = `${rc.date}|${rc.customer}|${rc.manager}|${rc.sale}`;
    return !usedRegisterKeys.has(rcKey) && rc.sale > 0;
  });

  // Group remaining portal contracts by customer cluster (sim >= 0.75 and dates within 14 days)
  const portalClusters: PortalContractInput[][] = [];
  const clusteredPortalIds = new Set<string | number>();

  for (let i = 0; i < remainingPortal.length; i++) {
    const p1 = remainingPortal[i];
    if (clusteredPortalIds.has(p1.id)) continue;
    const cluster = [p1];
    clusteredPortalIds.add(p1.id);

    for (let j = i + 1; j < remainingPortal.length; j++) {
      const p2 = remainingPortal[j];
      if (clusteredPortalIds.has(p2.id)) continue;

      const sim = calculateNameSimilarity(
        p1.customer_organization_name || "",
        p2.customer_organization_name || ""
      );
      if (sim < 0.75) continue;

      const time1 = Date.parse(p1.sign_date || "");
      const time2 = Date.parse(p2.sign_date || "");
      if (Math.abs((time1 - time2) / 86_400_000) <= 14) {
        cluster.push(p2);
        clusteredPortalIds.add(p2.id);
      }
    }

    portalClusters.push(cluster);
  }

  for (const cluster of portalClusters) {
    if (cluster.some((pc) => usedPortalIds.has(pc.id))) continue;
    const firstP = cluster[0];
    const pSum = cluster.reduce((sum, pc) => sum + (pc.contract_price_with_vat || 0), 0);

    // Find candidate register contracts of the same customer in that 14-day window
    const candidateReg = remainingRegister.filter((rc) => {
      const rcKey = `${rc.date}|${rc.customer}|${rc.manager}|${rc.sale}`;
      if (usedRegisterKeys.has(rcKey)) return false;

      const sim = calculateNameSimilarity(firstP.customer_organization_name || "", rc.customer);
      if (sim < 0.75) return false;

      const rTime = Date.parse(rc.date || "");
      return cluster.some((pc) => {
        const pcTime = Date.parse(pc.sign_date || "");
        return Math.abs((rTime - pcTime) / 86_400_000) <= 14;
      });
    });

    if (candidateReg.length === 0) continue;
    // Pass 2 is customer sum matching: requires multiple portal contracts or multiple register contracts
    if (cluster.length <= 1 && candidateReg.length <= 1) continue;

    let matchedRegItems: RegisterContract[] | null = null;
    const totalRegSum = candidateReg.reduce((sum, rc) => sum + rc.sale, 0);
    const devRawTotal = Math.abs(pSum / totalRegSum - 1);
    const dev12Total = Math.abs(pSum / (totalRegSum * 1.12) - 1);
    const dev16Total = Math.abs(pSum / (totalRegSum * 1.16) - 1);

    if (Math.min(devRawTotal, dev12Total, dev16Total) <= 0.03) {
      matchedRegItems = candidateReg;
    } else {
      for (const rc of candidateReg) {
        const devRaw = Math.abs(pSum / rc.sale - 1);
        const dev12 = Math.abs(pSum / (rc.sale * 1.12) - 1);
        const dev16 = Math.abs(pSum / (rc.sale * 1.16) - 1);
        if (Math.min(devRaw, dev12, dev16) <= 0.03) {
          matchedRegItems = [rc];
          break;
        }
      }
    }

    if (matchedRegItems) {
      for (const pc of cluster) {
        usedPortalIds.add(pc.id);
      }
      for (const rc of matchedRegItems) {
        const rcKey = `${rc.date}|${rc.customer}|${rc.manager}|${rc.sale}`;
        usedRegisterKeys.add(rcKey);
      }
      matchedByCustomerSumCount += cluster.length;
      matchedByCustomerSumPairs.push({
        portalIds: cluster.map((pc) => pc.id),
        registerKeys: matchedRegItems.map((rc) => `${rc.date}|${rc.customer}|${rc.manager}|${rc.sale}`),
        customer: firstP.customer_organization_name || ""
      });
    }
  }

  // Pass 3: 1-to-1 with neighbor month (monthDiff === 1) on remaining items
  const pass3Pairs = find1to1CandidatePairs(1);
  applyCandidatePairs(pass3Pairs);

  const matched1to1Count = matchedPairs.length;

  const missingContracts: RegisterPortalMissingContract[] = [];
  for (const pc of portalContracts) {
    if (!usedPortalIds.has(pc.id)) {
      missingContracts.push({
        id: pc.id,
        contractNumber: pc.contract_number || String(pc.id),
        signDate: pc.sign_date || "",
        customer: pc.customer_organization_name || "Не указан",
        amountWithVat: pc.contract_price_with_vat || 0,
        method: pc.purchase_method_name || "Не указан",
        supplier: pc.supplier || "Группа F3"
      });
    }
  }

  return {
    matchedCount: usedPortalIds.size,
    matched1to1Count,
    matchedByCustomerSumCount,
    matchedPairs,
    matchedByCustomerSumPairs,
    missingContracts
  };
}

function isWorkingDay(dateStr: string, holidays: Set<string>): boolean {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !holidays.has(dateStr);
}

function getWorkingDays(startDate: string, endDate: string, holidays: Set<string>): string[] {
  const cur = new Date(startDate);
  const end = new Date(endDate);
  const res: string[] = [];
  while (cur <= end) {
    const dStr = cur.toISOString().slice(0, 10);
    if (isWorkingDay(dStr, holidays)) res.push(dStr);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return res;
}

function workingDaysBetween(startDate: string, endDate: string, holidays: Set<string>): number {
  if (startDate > endDate) return 0;
  return Math.max(0, getWorkingDays(startDate, endDate, holidays).length - 1);
}

export function getNextWorkingDay(dateStr: string, holidays: Set<string>): string {
  let cur = new Date(Date.parse(dateStr + "T00:00:00Z"));
  while (true) {
    cur = new Date(cur.getTime() + 86400000);
    const dayOfWeek = cur.getUTCDay();
    const iso = cur.toISOString().slice(0, 10);
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidays.has(iso)) {
      return iso;
    }
  }
}

export function detectRegisterDiscipline(params: {
  startDate: string;
  endDate: string;
  holidays?: Set<string>;
  fileEntries: Array<{
    fileName: string;
    dateKey: string;
    updateTime?: string;
    rows: RegisterRow[];
  }>;
  currentMonth?: string;
  firstFileBaseline?: boolean;
}): RegisterDisciplineView {
  const { startDate, endDate, fileEntries } = params;
  const holidays = params.holidays instanceof Set ? params.holidays : new Set(params.holidays || []);

  const sortedFiles = [...fileEntries].sort(compareRegisterFiles);

  // 1. Missing working days
  const expectedWorkingDays = getWorkingDays(startDate, endDate, holidays);
  const presentDates = new Set(sortedFiles.map((f) => f.dateKey));
  const missingWorkingDays = expectedWorkingDays.filter((d) => !presentDates.has(d));

  // 2. Track rows across files: match edits with previous versions and identify genuinely new rows
  const fileTrackedRows: Array<Array<{ row: RegisterRow; firstSeenDate: string; isFromFirstFile: boolean }>> = [];

  for (let fIdx = 0; fIdx < sortedFiles.length; fIdx++) {
    const file = sortedFiles[fIdx];
    const isFirstFile = fIdx === 0;
    const tracked: Array<{ row: RegisterRow; firstSeenDate: string; isFromFirstFile: boolean }> = [];

    if (isFirstFile) {
      for (const r of file.rows) {
        tracked.push({
          row: r,
          firstSeenDate: file.dateKey,
          isFromFirstFile: true
        });
      }
    } else {
      const prevTracked = fileTrackedRows[fIdx - 1];
      const usedPrevIndices = new Set<number>();
      const matchedCurIndices = new Set<number>();

      // Pass 1: exact matches
      for (let cIdx = 0; cIdx < file.rows.length; cIdx++) {
        const curR = file.rows[cIdx];
        for (let pIdx = 0; pIdx < prevTracked.length; pIdx++) {
          if (usedPrevIndices.has(pIdx)) continue;
          const prev = prevTracked[pIdx];
          if (
            curR.date === prev.row.date &&
            curR.customer === prev.row.customer &&
            curR.product === prev.row.product &&
            curR.sale === prev.row.sale &&
            curR.cost === prev.row.cost &&
            curR.manager === prev.row.manager
          ) {
            usedPrevIndices.add(pIdx);
            matchedCurIndices.add(cIdx);
            tracked.push({
              row: curR,
              firstSeenDate: prev.firstSeenDate,
              isFromFirstFile: prev.isFromFirstFile
            });
            break;
          }
        }
      }

      // Pass 2: modified matches (same customer and product, closest sale)
      for (let cIdx = 0; cIdx < file.rows.length; cIdx++) {
        if (matchedCurIndices.has(cIdx)) continue;
        const curR = file.rows[cIdx];
        let bestPIdx = -1;
        let bestDist = Infinity;

        for (let pIdx = 0; pIdx < prevTracked.length; pIdx++) {
          if (usedPrevIndices.has(pIdx)) continue;
          const prev = prevTracked[pIdx];
          if (curR.customer === prev.row.customer && curR.product === prev.row.product) {
            const dist = Math.abs(curR.sale - prev.row.sale);
            if (dist < bestDist) {
              bestDist = dist;
              bestPIdx = pIdx;
            }
          }
        }

        if (bestPIdx !== -1) {
          usedPrevIndices.add(bestPIdx);
          matchedCurIndices.add(cIdx);
          const prev = prevTracked[bestPIdx];
          tracked.push({
            row: curR,
            firstSeenDate: prev.firstSeenDate,
            isFromFirstFile: prev.isFromFirstFile
          });
        }
      }

      // Pass 3: genuinely new rows
      for (let cIdx = 0; cIdx < file.rows.length; cIdx++) {
        if (matchedCurIndices.has(cIdx)) continue;
        const curR = file.rows[cIdx];
        tracked.push({
          row: curR,
          firstSeenDate: file.dateKey,
          isFromFirstFile: false
        });
      }
    }

    fileTrackedRows.push(tracked);
  }

  const curMonth = params.currentMonth || endDate.slice(0, 7);
  const prevMonth = getPrevMonth(curMonth);

  const laggedRowsByManager = new Map<string, number>();
  let laggedRowsCount = 0;
  const countedNewRowKeys = new Set<string>();

  for (const trackedList of fileTrackedRows) {
    for (const item of trackedList) {
      if (item.isFromFirstFile) continue; // Rows in first file are baseline, not late
      const r = item.row;
      if (!r.date) continue;
      const rMonth = r.date.slice(0, 7);

      // Only count late rows for current and previous month
      if (rMonth < prevMonth || rMonth > curMonth) continue;

      const lagKey = `${r.date}|${r.customer}|${r.product}|${item.firstSeenDate}`;
      if (countedNewRowKeys.has(lagKey)) continue;
      countedNewRowKeys.add(lagKey);

      const lag = workingDaysBetween(r.date, item.firstSeenDate, holidays);
      if (lag >= 2) {
        // Point 3 Rule:
        // A row with date D is late ONLY IF there is an existing file dated from the next working day after D up to firstSeenDate, and the row is absent in it.
        const nextWd = getNextWorkingDay(r.date, holidays);
        const hasIntermediateFile = sortedFiles.some(
          (f) => f.dateKey >= nextWd && f.dateKey < item.firstSeenDate
        );
        if (hasIntermediateFile) {
          laggedRowsCount++;
          const mgr = r.manager || "Не указан";
          laggedRowsByManager.set(mgr, (laggedRowsByManager.get(mgr) || 0) + 1);
        }
      }
    }
  }

  const laggedByManager = Array.from(laggedRowsByManager.entries())
    .map(([manager, count]) => ({ manager, count }))
    .sort((a, b) => b.count - a.count);

  // 3. Sales below cost (excluding 0 / 0 rows)
  const salesBelowCost: Array<{
    date: string;
    manager: string;
    customer: string;
    product: string;
    sale: number;
    cost: number;
  }> = [];

  const seenNegativeRows = new Set<string>();
  for (const f of sortedFiles) {
    for (const r of f.rows) {
      if (r.sale === 0 && r.cost === 0) continue;
      const loss = r.cost - r.sale;
      if (r.cost > r.sale && r.cost > 0 && loss >= 1) {
        const key = `${r.date}|${r.customer}|${r.product}|${r.sale}|${r.cost}`;
        if (!seenNegativeRows.has(key)) {
          seenNegativeRows.add(key);
          salesBelowCost.push({
            date: r.date,
            manager: r.manager,
            customer: r.customer,
            product: r.product,
            sale: r.sale,
            cost: r.cost
          });
        }
      }
    }
  }

  // 4. Retroactive changes between successive files of the same month with strict 1-to-1 matching
  const retroChanges: RegisterDisciplineRetroChange[] = [];

  for (let i = 0; i < sortedFiles.length - 1; i++) {
    const f1 = sortedFiles[i];
    const f2 = sortedFiles[i + 1];
    if (f1.dateKey.slice(0, 7) !== f2.dateKey.slice(0, 7)) continue; // same month only

    const usedF2Indices = new Set<number>();
    const matchedF1Indices = new Set<number>();

    // Pass 1: exact matches (date, customer, product, sale, cost, manager)
    for (let i1 = 0; i1 < f1.rows.length; i1++) {
      const r1 = f1.rows[i1];
      for (let i2 = 0; i2 < f2.rows.length; i2++) {
        if (usedF2Indices.has(i2)) continue;
        const r2 = f2.rows[i2];
        if (
          r1.date === r2.date &&
          r1.customer === r2.customer &&
          r1.product === r2.product &&
          r1.sale === r2.sale &&
          r1.cost === r2.cost &&
          r1.manager === r2.manager
        ) {
          usedF2Indices.add(i2);
          matchedF1Indices.add(i1);
          break;
        }
      }
    }

    // Pass 2: modified matches (same customer and product, closest sale)
    for (let i1 = 0; i1 < f1.rows.length; i1++) {
      if (matchedF1Indices.has(i1)) continue;
      const r1 = f1.rows[i1];

      let bestI2 = -1;
      let bestDist = Infinity;

      for (let i2 = 0; i2 < f2.rows.length; i2++) {
        if (usedF2Indices.has(i2)) continue;
        const r2 = f2.rows[i2];
        if (r1.customer === r2.customer && r1.product === r2.product) {
          const dist = Math.abs(r1.sale - r2.sale);
          if (dist < bestDist) {
            bestDist = dist;
            bestI2 = i2;
          }
        }
      }

      if (bestI2 !== -1) {
        usedF2Indices.add(bestI2);
        matchedF1Indices.add(i1);
        const r2 = f2.rows[bestI2];

        const diff: RegisterDisciplineRetroChange["diff"] = {};
        const parts: string[] = [];

        if (r1.sale !== r2.sale) {
          diff.sale = { before: r1.sale, after: r2.sale };
          parts.push(`сумма: ${r1.sale} → ${r2.sale}`);
        }
        if (r1.cost !== r2.cost) {
          diff.cost = { before: r1.cost, after: r2.cost };
          parts.push(`закуп: ${r1.cost} → ${r2.cost}`);
        }
        if (r1.manager !== r2.manager) {
          diff.manager = { before: r1.manager, after: r2.manager };
          parts.push(`менеджер: ${r1.manager} → ${r2.manager}`);
        }
        if (r1.date !== r2.date) {
          diff.date = { before: r1.date, after: r2.date };
          parts.push(`дата: ${r1.date} → ${r2.date}`);
        }

        if (parts.length > 0) {
          retroChanges.push({
            date: r1.date,
            manager: r1.manager,
            customer: r1.customer,
            product: r1.product,
            sale: r1.sale,
            type: "modified",
            note: `Изменено в ${f2.fileName}: ${parts.join("; ")}`,
            diff
          });
        }
      }
    }

    // Pass 3: deleted rows
    for (let i1 = 0; i1 < f1.rows.length; i1++) {
      if (matchedF1Indices.has(i1)) continue;
      const r1 = f1.rows[i1];
      retroChanges.push({
        date: r1.date,
        manager: r1.manager,
        customer: r1.customer,
        product: r1.product,
        sale: r1.sale,
        type: "deleted",
        note: `Строка исчезла в файле ${f2.fileName}`,
        diff: {
          sale: { before: r1.sale, after: 0 }
        }
      });
    }
  }

  return {
    missingWorkingDays,
    laggedRowsCount,
    laggedByManager,
    retroChanges,
    salesBelowCost
  };
}

export async function searchOrganizationByBin(
  bin: string,
  options?: ZakupApiOptions
): Promise<number | null> {
  try {
    const page = await zakupGet<ZakupPage<{ id: number; bin?: string; name_ru?: string }>>(
      "/public/organizations/",
      { q: bin },
      options
    );
    const results = page?.results;
    if (Array.isArray(results)) {
      const exact = results.find((o) => String(o.bin || "").trim() === bin);
      if (exact && exact.id) return exact.id;
    }
    return null;
  } catch (err) {
    console.warn(`[Портал] Ошибка поиска организации по БИН ${bin}:`, err);
    return null;
  }
}

export async function resolveGroupSupplierOrgIds(
  outcomesConfig: any,
  orgsCache: Record<string, string> | null,
  options?: {
    marketConfigPath?: string;
    fetchFn?: typeof fetch;
  }
): Promise<{
  suppliers: Array<{ orgId: number; supplierName: string; bin: string }>;
  error?: string;
  f3OrgId?: number;
  f3OrgIds: number[];
  partnerOrgIds: number[];
}> {
  const f3OrgIds: number[] = [];
  const partnerOrgIds: number[] = [];
  const suppliers: Array<{ orgId: number; supplierName: string; bin: string }> = [];

  if (!outcomesConfig) {
    return { suppliers, f3OrgIds, partnerOrgIds, error: "Конфиг gz-deal-outcomes не найден" };
  }

  let binToName = new Map<string, string>();
  try {
    const marketCfg = loadMarketConfig(options?.marketConfigPath);
    if (marketCfg?.ourBins) {
      for (const entry of marketCfg.ourBins) {
        if (typeof entry === "object" && entry !== null && "bin" in entry && entry.bin) {
          if (entry.name) {
            binToName.set(String(entry.bin).trim(), entry.name);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  const binToId = new Map<string, number>();
  if (orgsCache) {
    for (const [idStr, bin] of Object.entries(orgsCache)) {
      const id = Number(idStr);
      if (!Number.isNaN(id) && bin) {
        binToId.set(String(bin).trim(), id);
      }
    }
  }

  // Resolve F3 Bins
  const ourBins: string[] = outcomesConfig.ourBins ? outcomesConfig.ourBins.map((b: unknown) => String(b).trim()) : [];
  for (const bin of ourBins) {
    let orgId = binToId.get(bin);
    if (!orgId) {
      const found = await searchOrganizationByBin(bin, { fetchFn: options?.fetchFn });
      if (found) {
        orgId = found;
        binToId.set(bin, orgId);
      }
    }
    if (orgId) {
      f3OrgIds.push(orgId);
      const sName = binToName.get(bin) || "F3";
      suppliers.push({ orgId, supplierName: sName, bin });
    } else {
      return {
        suppliers,
        f3OrgId: f3OrgIds[0],
        f3OrgIds,
        partnerOrgIds,
        error: `Не найдена организация поставщика группы F3 (БИН ${bin}) на портале zakup.gov.kz`
      };
    }
  }

  // Resolve Partner Bins
  const partnerBins: string[] = outcomesConfig.partnerBins ? outcomesConfig.partnerBins.map((b: unknown) => String(b).trim()) : [];
  for (const bin of partnerBins) {
    let orgId = binToId.get(bin);
    if (!orgId) {
      const found = await searchOrganizationByBin(bin, { fetchFn: options?.fetchFn });
      if (found) {
        orgId = found;
        binToId.set(bin, orgId);
      }
    }
    if (orgId) {
      partnerOrgIds.push(orgId);
      const sName = binToName.get(bin) || "Партнёр";
      suppliers.push({ orgId, supplierName: sName, bin });
    } else {
      return {
        suppliers,
        f3OrgId: f3OrgIds[0],
        f3OrgIds,
        partnerOrgIds,
        error: `Не найдена организация партнёра (БИН ${bin}) на портале zakup.gov.kz`
      };
    }
  }

  return { suppliers, f3OrgId: f3OrgIds[0], f3OrgIds, partnerOrgIds };
}

export function loadStoredRegisterHistory(
  cacheFilePath = DEFAULT_REGISTER_HISTORY_PATH,
  key = process.env.REGISTER_HISTORY_KEY
): RegisterHistoryPayload | null {
  const res = loadEncryptedRegisterHistory(cacheFilePath, key);
  return res.payload || null;
}

export function saveRegisterHistory(
  cacheFilePath: string,
  history: RegisterHistoryPayload,
  key = process.env.REGISTER_HISTORY_KEY
): void {
  saveEncryptedRegisterHistory(cacheFilePath, history, key);
}

export async function fetchPortalContractsForMonths(params: {
  supplierOrgIds: Array<{ orgId: number; supplierName: string; bin?: string }>;
  months: string[];
  fetchFn?: typeof fetch;
}): Promise<PortalContractInput[]> {
  const result: PortalContractInput[] = [];

  // Fetch contract statuses dictionary for status exclusions
  const statusEgz = new Map<number, number>();
  try {
    const rawStatuses = asList<ZakupDictItem>(
      await zakupGet("/dicts/contract-statuses/", {}, { fetchFn: params.fetchFn })
    );
    for (const item of rawStatuses) {
      const egz = Number(item.egz_code);
      if (item.egz_code && Number.isFinite(egz)) {
        statusEgz.set(item.id, egz);
      }
    }
  } catch (err) {
    throw new Error(
      `Не удалось загрузить справочник статусов договоров с портала zakup.gov.kz: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (statusEgz.size === 0) {
    throw new Error("Справочник статусов договоров с портала zakup.gov.kz пуст или не содержит кодов ЭГЗ");
  }

  const marketCfg = loadMarketConfig();

  for (const month of params.months) {
    const lastDay = getLastDayOfMonth(month);

    for (const sup of params.supplierOrgIds) {
      try {
        const items = await zakupListAll<PortalContractInput>(
          "public/contracts/",
          {
            supplier_organization_id: sup.orgId,
            sign_date__gte: `${month}-01`,
            sign_date__lte: lastDay
          },
          { fetchFn: params.fetchFn }
        );

        for (const item of items) {
          // Status filtering: exclude 455 (Изменен), 350, 340 (Расторгнут)
          if (item.status_id != null) {
            const egz = statusEgz.get(Number(item.status_id));
            if (egz !== undefined && isExcludedStatus(egz, marketCfg)) {
              continue;
            }
          }

          result.push({
            ...item,
            supplier: sup.supplierName,
            supplier_organization_id: sup.orgId,
            supplier_organization_bin: sup.bin
          });
        }
      } catch (err) {
        throw new Error(
          `Портал zakup вернул ошибку при запросе договоров ${sup.supplierName} (org ${sup.orgId}) за ${month}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return result;
}

function asList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const results = (body as { results?: unknown })?.results;
  return Array.isArray(results) ? (results as T[]) : [];
}

export interface BuildFullRegisterHistoryOptions {
  files: Array<{
    fileName: string;
    buffer: Buffer;
    updateTime?: string;
  }>;
  managerAliases?: Record<string, string>;
  todayAlmaty: string;
  crmWonDealsByMonth?: Map<string, CrmWonDeal[]>;
  crmWonDeals?: CrmWonDeal[];
  holidays?: Set<string>;
  outcomesConfigPath?: string;
  orgsCachePath?: string;
  fetchPortal?: boolean;
  failedFiles?: Array<{ fileName: string; reason: string }>;
}

export function reconcileRegisterWithCrmAcrossMonths(
  months: RegisterMonthSummary[],
  parsedFiles: Array<{ fileName: string; rows: RegisterRow[] }>,
  dealsWonByExactMonth: Map<string, CrmWonDeal[]>,
  options?: { managerAliases?: Record<string, string> }
): void {
  const sortedSummaries = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const usedDealIds = new Set<string>();

  // Pass 1: Reconcile each month with deals won in that exact same month
  const unmatchedContractsByMonth = new Map<string, RegisterContract[]>();
  const availableDealsByMonth = new Map<string, CrmWonDeal[]>();

  for (const summary of sortedSummaries) {
    const m = summary.month;
    const monthFile = parsedFiles.find((pf) => pf.fileName === summary.fileName);
    const contracts = monthFile ? groupRegisterContracts(monthFile.rows) : [];
    const sameMonthDeals = (dealsWonByExactMonth.get(m) || []).filter((d) => !usedDealIds.has(d.id));

    const matchRes1 = matchRegisterWithCrm(contracts, sameMonthDeals, {
      managerAliases: options?.managerAliases
    });

    for (const item of matchRes1.matched) {
      usedDealIds.add(item.deal.id);
    }

    unmatchedContractsByMonth.set(m, matchRes1.missing);
    availableDealsByMonth.set(m, matchRes1.extra);
    summary.reconciliationPerformed = true;
    summary.missingCrm = matchRes1.missing.map((c) => ({
      date: c.date,
      manager: c.manager,
      customer: c.customer,
      sale: c.sale,
      products: c.products,
      type: c.type
    }));
  }

  // Pass 2: Remaining contracts of month M match against remaining deals of month M+1
  for (const summary of sortedSummaries) {
    const m = summary.month;
    const nextM = getNextMonth(m);
    const remainingContracts = unmatchedContractsByMonth.get(m) || [];

    if (remainingContracts.length === 0) {
      summary.missingCrm = [];
      continue;
    }

    const nextMonthAvailableDeals = (
      availableDealsByMonth.has(nextM)
        ? availableDealsByMonth.get(nextM)!
        : (dealsWonByExactMonth.get(nextM) || [])
    ).filter((d) => !usedDealIds.has(d.id));

    if (nextMonthAvailableDeals.length === 0) {
      continue;
    }

    const matchRes2 = matchRegisterWithCrm(remainingContracts, nextMonthAvailableDeals, {
      managerAliases: options?.managerAliases
    });

    for (const item of matchRes2.matched) {
      usedDealIds.add(item.deal.id);
    }

    const newlyUsedDealIds = new Set(matchRes2.matched.map((x) => x.deal.id));
    availableDealsByMonth.set(
      nextM,
      nextMonthAvailableDeals.filter((d) => !newlyUsedDealIds.has(d.id))
    );

    summary.missingCrm = matchRes2.missing.map((c) => ({
      date: c.date,
      manager: c.manager,
      customer: c.customer,
      sale: c.sale,
      products: c.products,
      type: c.type
    }));
  }
}

export async function buildFullRegisterHistory(
  options: BuildFullRegisterHistoryOptions
): Promise<RegisterHistoryPayload> {
  const parsedFiles: Array<{
    fileName: string;
    dateKey: string;
    updateTime: string;
    rows: RegisterRow[];
    plans: Record<string, number>;
    hasValColumn: boolean;
  }> = [];

  for (const f of options.files) {
    try {
      const p = await parseRegisterExcel(f.buffer, f.fileName, options.managerAliases);
      parsedFiles.push({
        fileName: f.fileName,
        dateKey: p.asOf,
        updateTime: f.updateTime || "",
        rows: p.rows,
        plans: p.plans,
        hasValColumn: p.hasValColumn
      });
    } catch (err) {
      console.warn(`[Реестр История] Не удалось разобрать ${f.fileName}:`, err);
    }
  }

  // Monthly summaries (July 2026 onwards)
  const monthsSet = new Set<string>();
  for (const pf of parsedFiles) {
    if (pf.dateKey) {
      const m = pf.dateKey.slice(0, 7);
      if (m >= "2026-07") monthsSet.add(m);
    }
  }
  const sortedMonths = Array.from(monthsSet).sort();

  const months: RegisterMonthSummary[] = [];
  const allFinalContracts: RegisterContract[] = [];

  for (const m of sortedMonths) {
    const monthFiles = parsedFiles.filter((pf) => pf.dateKey.slice(0, 7) === m);
    let finalPf = monthFiles[0];
    for (const cur of monthFiles) {
      if (compareRegisterFiles(cur, finalPf) > 0) {
        finalPf = cur;
      }
    }

    const summary = buildRegisterMonthSummary({
      month: m,
      fileName: finalPf.fileName,
      rows: finalPf.rows,
      plans: finalPf.plans,
      hasValColumn: finalPf.hasValColumn
    });

    const contracts = groupRegisterContracts(finalPf.rows);
    allFinalContracts.push(...contracts);
    months.push(summary);
  }

  // CRM reconciliation across months
  if (options.crmWonDealsByMonth) {
    reconcileRegisterWithCrmAcrossMonths(
      months,
      parsedFiles,
      options.crmWonDealsByMonth,
      { managerAliases: options.managerAliases }
    );
  } else if (options.crmWonDeals && sortedMonths.length > 0) {
    const lastM = sortedMonths[sortedMonths.length - 1];
    reconcileRegisterWithCrmAcrossMonths(
      months,
      parsedFiles,
      new Map([[lastM, options.crmWonDeals]]),
      { managerAliases: options.managerAliases }
    );
    for (const s of months) {
      if (s.month !== lastM) s.reconciliationPerformed = false;
    }
  } else {
    for (const s of months) {
      s.reconciliationPerformed = false;
    }
  }

  // Portal reconciliation (match against allFinalContracts grouped per month individually)
  let portalMissing: RegisterPortalReconciliationView | undefined;
  if (options.fetchPortal !== false && sortedMonths.length > 0) {
    try {
      const outcomesPath = path.resolve(options.outcomesConfigPath || "config/gz-deal-outcomes.json");
      const orgsPath = path.resolve(options.orgsCachePath || "data/market/orgs.json");
      let outcomesConfig = null;
      let orgsCache = null;
      if (fs.existsSync(outcomesPath)) outcomesConfig = JSON.parse(fs.readFileSync(outcomesPath, "utf8"));
      if (fs.existsSync(orgsPath)) orgsCache = JSON.parse(fs.readFileSync(orgsPath, "utf8"));

      const { suppliers, error: orgResolutionError, f3OrgIds, partnerOrgIds } = await resolveGroupSupplierOrgIds(outcomesConfig, orgsCache);

      if (orgResolutionError || suppliers.length === 0) {
        portalMissing = {
          currentMonth: sortedMonths[sortedMonths.length - 1] || "",
          previousMonth: sortedMonths[sortedMonths.length - 2] || "",
          missingContracts: [],
          monthlyCounts: {},
          error: orgResolutionError || "Не удалось определить организации группы F3 на портале zakup.gov.kz"
        };
      } else {
        const currentMonth = sortedMonths[sortedMonths.length - 1];
        const prevMonth = sortedMonths.length > 1 ? sortedMonths[sortedMonths.length - 2] : currentMonth;
        const targetMonths = Array.from(new Set([currentMonth, prevMonth]));

        const portalContracts = await fetchPortalContractsForMonths({
          supplierOrgIds: suppliers,
          months: sortedMonths
        });

        // 1-to-1 match and customer sum match against all final contracts
        const portalRes = matchPortalContracts1to1(portalContracts, allFinalContracts);

        const f3OrgIdsSet = new Set(f3OrgIds || []);
        const partnerOrgIdsSet = new Set(partnerOrgIds || []);

        const monthlyCounts: Record<
          string,
          {
            f3: number;
            partner: number;
            total: number;
            matched?: number;
            matched1to1?: number;
            matchedByCustomerSum?: number;
            missing?: number;
          }
        > = {};

        for (const tm of sortedMonths) {
          const inMonth = portalContracts.filter((c) => String(c.sign_date || "").startsWith(tm));
          const f3Count = inMonth.filter((c) =>
            f3OrgIdsSet.has(Number(c.supplier_organization_id))
          ).length;
          const partnerCount = inMonth.filter((c) =>
            partnerOrgIdsSet.has(Number(c.supplier_organization_id))
          ).length;
          const inMonthMissing = portalRes.missingContracts.filter((c) => c.signDate.startsWith(tm)).length;
          const inMonthMatched = inMonth.length - inMonthMissing;

          const matched1to1InMonth = portalRes.matchedPairs.filter((p) =>
            String(p.portal.sign_date || "").startsWith(tm)
          ).length;
          const matchedByCustomerSumInMonth = inMonthMatched - matched1to1InMonth;

          monthlyCounts[tm] = {
            f3: f3Count,
            partner: partnerCount,
            total: inMonth.length,
            matched: inMonthMatched,
            matched1to1: matched1to1InMonth,
            matchedByCustomerSum: Math.max(0, matchedByCustomerSumInMonth),
            missing: inMonthMissing
          };
        }

        const missingContracts = portalRes.missingContracts.filter((c) =>
          targetMonths.some((tm) => c.signDate.startsWith(tm))
        );

        portalMissing = {
          currentMonth,
          previousMonth: prevMonth,
          missingContracts,
          monthlyCounts,
          matched1to1Count: portalRes.matched1to1Count,
          matchedByCustomerSumCount: portalRes.matchedByCustomerSumCount
        };
      }
    } catch (err) {
      console.warn(`[Реестр История] Ошибка сверки с порталом:`, err);
      portalMissing = {
        currentMonth: sortedMonths[sortedMonths.length - 1] || "",
        previousMonth: sortedMonths[sortedMonths.length - 2] || "",
        missingContracts: [],
        monthlyCounts: {},
        error: `Ошибка сверки с порталом: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  // Discipline: period starts from first file chronologically, ends yesterday Almaty
  const sortedChronologically = [...parsedFiles].sort(compareRegisterFiles);
  const firstDate = sortedChronologically[0]?.dateKey || options.todayAlmaty;
  const yesterdayAlmaty = new Date(Date.parse(options.todayAlmaty + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  const holidays = options.holidays instanceof Set ? options.holidays : new Set(options.holidays || []);

  const discipline = detectRegisterDiscipline({
    startDate: firstDate,
    endDate: yesterdayAlmaty,
    holidays,
    fileEntries: sortedChronologically.map((pf) => ({
      fileName: pf.fileName,
      dateKey: pf.dateKey,
      updateTime: pf.updateTime,
      rows: pf.rows
    })),
    currentMonth: options.todayAlmaty.slice(0, 7)
  });

  return {
    asOf: options.todayAlmaty,
    months,
    portalMissing,
    discipline,
    failedFiles: options.failedFiles
  };
}
