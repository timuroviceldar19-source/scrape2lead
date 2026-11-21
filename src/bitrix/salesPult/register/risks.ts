import { isPartnerSale } from "./parseExcel.js";
import type { RegisterRiskRow, RegisterRisksSummary, RegisterRow } from "./types.js";

/** Сигналы по строкам одного среза реестра. Убытки и отклонения в итогах — по модулю. */
export function buildRegisterRisks(rows: readonly RegisterRow[], hasVal: boolean): RegisterRisksSummary {
  const belowCost: RegisterRisksSummary["belowCost"]["rows"] = [];
  const lowMargin: RegisterRisksSummary["lowMargin"]["rows"] = [];
  const portalMismatch: RegisterRisksSummary["portalMismatch"]["rows"] = [];

  for (const r of rows) {
    const { date, manager, customer, product, sale, cost, portal } = r;
    const val = hasVal ? r.val : null;
    const margin = val !== null && sale > 0 ? val / sale : null;
    const row: RegisterRiskRow = { date, manager, customer, product, sale, val, margin };
    // Если сработали оба признака, показываем больший убыток и считаем строку один раз.
    const costLoss = cost > 0 && sale > 0 && cost > sale ? cost - sale : 0;
    const loss = Math.max(costLoss, val !== null && val < 0 ? -val : 0);
    if (loss > 0) belowCost.push({ ...row, loss });

    if (!isPartnerSale(r) && margin !== null && margin >= 0 && margin < 0.10) {
      lowMargin.push(row);
    }

    const difference = portal - sale;
    if (portal > 0 && sale > 0 && Math.abs(difference) > Math.max(10_000, sale * 0.01)
      && Math.abs(portal / sale - 1.12) > 0.015) {
      portalMismatch.push({ ...row, portal, difference });
    }
  }

  return {
    belowCost: {
      count: belowCost.length,
      loss: belowCost.reduce((sum, r) => sum + r.loss, 0),
      rows: belowCost.sort((a, b) => b.loss - a.loss)
    },
    lowMargin: {
      count: lowMargin.length,
      sale: lowMargin.reduce((sum, r) => sum + r.sale, 0),
      rows: lowMargin.sort((a, b) => b.sale - a.sale)
    },
    portalMismatch: {
      count: portalMismatch.length,
      difference: portalMismatch.reduce((sum, r) => sum + Math.abs(r.difference), 0),
      rows: portalMismatch.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
    }
  };
}
