// Вид пульта для РТО (Руководитель тендерного отдела):
// «Сегодня», «Радар», «Планы», «Рынок», «Конкуренты» — без страниц «Финансы» и «Выручка»,
// и без финансовых/реестровых пунктов в утреннем пульсе.

import type { PultViewer, SalesPultPayload } from "../types.js";
import { buildRtoPulse } from "../pulse.js";
import { renderPultHtml } from "../site.js";

export interface RtoVariantInput {
  pult: SalesPultPayload;
}

export interface RtoVariant {
  pult: SalesPultPayload;
}

const RTO_VIEWER: PultViewer = { kind: "rto" };

function stripFinanceAndRegisterFromPult(p: SalesPultPayload): SalesPultPayload {
  const closedMonths = p.closedMonths
    ? Object.fromEntries(Object.entries(p.closedMonths).map(([key, month]) => [key, month ? stripFinanceAndRegisterFromPult(month) : null]))
    : undefined;
  return {
    ...p,
    viewer: RTO_VIEWER,
    ...(p.pulse !== undefined ? { pulse: buildRtoPulse(p.pulse) } : {}),
    ...(closedMonths ? { closedMonths } : {})
  };
}

export function buildRtoVariant(input: RtoVariantInput): RtoVariant {
  return { pult: stripFinanceAndRegisterFromPult(input.pult) };
}

export function renderRtoVariant(variant: RtoVariant): { index: string } {
  return { index: renderPultHtml(variant.pult) };
}
