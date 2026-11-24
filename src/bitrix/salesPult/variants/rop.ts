// Вид пульта для РОП: весь отдел продаж, «Радар», «Выручка» (с бонусом РОП и сверкой),
// «Планы», «Рынок», «Конкуренты» — но без страницы «Финансы» и без финансовых пунктов в пульсе.

import type { PultViewer, SalesPultPayload } from "../types.js";
import { buildRopPulse } from "../pulse.js";
import { renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from "../site.js";

export interface RopVariantInput {
  pult: SalesPultPayload;
  reg: RegisterPagePayload;
}

export interface RopVariant {
  pult: SalesPultPayload;
  reg: RegisterPagePayload;
}

const ROP_VIEWER: PultViewer = { kind: "rop" };

function stripFinanceFromPult(p: SalesPultPayload): SalesPultPayload {
  const closedMonths = p.closedMonths
    ? Object.fromEntries(Object.entries(p.closedMonths).map(([key, month]) => [key, month ? stripFinanceFromPult(month) : null]))
    : undefined;
  return {
    ...p,
    viewer: ROP_VIEWER,
    ...(p.pulse !== undefined ? { pulse: buildRopPulse(p.pulse) } : {}),
    ...(closedMonths ? { closedMonths } : {})
  };
}

export function buildRopVariant(input: RopVariantInput): RopVariant {
  return {
    pult: stripFinanceFromPult(input.pult),
    reg: { ...input.reg, viewer: ROP_VIEWER }
  };
}

export function renderRopVariant(variant: RopVariant): { index: string; reg: string } {
  return {
    index: renderPultHtml(variant.pult),
    reg: renderRegisterHtml(variant.reg)
  };
}
