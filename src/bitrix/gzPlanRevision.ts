// A customer who edits a plan point gets a new point id under the same plan
// number, so the push script used to see the revision as a duplicate of the
// deal it already created and skip it. The deal kept the first version's
// amount, and the signed contract no longer matched it.

const PLAN_AMOUNT_FIELD = "UF_CRM_1715597423325";
const PLAN_QUANTITY_FIELD = "UF_CRM_6627AEBD67FFF";
// Plan amounts are published with kopecks; anything under a tenge is rounding.
const AMOUNT_TOLERANCE = 1;

export interface GzPlanRevisionDeal {
  ID?: string | number;
  ORIGINATOR_ID?: string | null;
  CLOSED?: string | null;
  OPPORTUNITY?: string | number | null;
  UF_CRM_1715597423325?: string | number | null;
  UF_CRM_6627AEBD67FFF?: string | number | null;
}

export interface GzPlanRevisionRow {
  amount: number;
  quantity: string;
  price: string;
  pricePerUnit: number;
  status: string;
  planUrl: string;
}

export interface GzPlanRevision {
  dealId: string;
  previousAmount: number;
  amount: number;
  previousQuantity: string;
  quantity: string;
  /** False when the manager already set their own deal amount. */
  updatesOpportunity: boolean;
}

export function detectGzPlanRevision(
  row: GzPlanRevisionRow,
  deal: GzPlanRevisionDeal,
  originatorId: string
): GzPlanRevision | null {
  const dealId = String(deal.ID ?? "").trim();
  if (!dealId || String(deal.ORIGINATOR_ID ?? "") !== originatorId) return null;
  if (String(deal.CLOSED ?? "").toUpperCase() === "Y") return null;
  if (!(row.amount > 0)) return null;

  const opportunity = toNumber(deal.OPPORTUNITY);
  const storedPlanAmount = toNumber(deal[PLAN_AMOUNT_FIELD]);
  const previousAmount = storedPlanAmount ?? opportunity;
  if (previousAmount === null) return null;

  const previousQuantity = String(deal[PLAN_QUANTITY_FIELD] ?? "").trim();
  const quantity = row.quantity.trim();
  const amountChanged = Math.abs(row.amount - previousAmount) >= AMOUNT_TOLERANCE;
  const quantityChanged = quantitiesDiffer(previousQuantity, quantity);
  if (!amountChanged && !quantityChanged) return null;

  return {
    dealId,
    previousAmount,
    amount: row.amount,
    previousQuantity,
    quantity,
    updatesOpportunity: opportunity === null || Math.abs(opportunity - previousAmount) < AMOUNT_TOLERANCE
  };
}

export function buildGzPlanRevisionFields(
  row: GzPlanRevisionRow,
  revision: GzPlanRevision
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    ...(revision.updatesOpportunity ? { OPPORTUNITY: revision.amount } : {}),
    [PLAN_AMOUNT_FIELD]: revision.amount.toFixed(2),
    UF_CRM_6627AEBD5E68B: row.price,
    [PLAN_QUANTITY_FIELD]: row.quantity,
    UF_CRM_COUNT: row.quantity,
    UF_CRM_PRICE_PER_UNIT: row.pricePerUnit > 0 ? `${row.pricePerUnit}|KZT` : undefined,
    UF_CRM_6627AEBD85B4D: row.status,
    UF_CRM_PLAN_STATUS: row.status
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")
  );
}

export function buildGzPlanRevisionComment(row: GzPlanRevisionRow, revision: GzPlanRevision): string {
  const lines = [
    "План изменён заказчиком.",
    `Сумма: ${formatTenge(revision.previousAmount)} → ${formatTenge(revision.amount)} ₸`
  ];
  if (quantitiesDiffer(revision.previousQuantity, revision.quantity)) {
    lines.push(`Количество: ${revision.previousQuantity} → ${revision.quantity}`);
  }
  if (row.planUrl) lines.push(`Новая версия пункта плана: ${row.planUrl}`);
  if (!revision.updatesOpportunity) {
    lines.push("Сумму сделки не менял: она отличается от плановой, похоже, её правили вручную.");
  }
  return lines.join("\n");
}

/**
 * zakup.gov.kz хранит и старые версии пункта со статусом «Утвержден». Если к одной сделке в прогоне ведут
 * несколько пунктов, сумму может менять только самый новый (номер пункта растёт с каждой версией).
 * Возвращает индексы строк, чью правку надо отложить.
 */
export function findOutdatedRevisionIndexes(
  items: ReadonlyArray<{ dealId: string | null; planPointId: string; revises: boolean }>
): Set<number> {
  const newest = new Map<string, number>();
  for (const item of items) {
    const point = Number(item.planPointId);
    if (!item.dealId || !Number.isFinite(point)) continue;
    newest.set(item.dealId, Math.max(newest.get(item.dealId) ?? point, point));
  }
  const outdated = new Set<number>();
  items.forEach((item, index) => {
    if (item.revises && item.dealId && Number(item.planPointId) < (newest.get(item.dealId) ?? -Infinity)) outdated.add(index);
  });
  return outdated;
}

/** Two rows of one run rewriting the same deal means we cannot tell which version is current. */
export function findAmbiguousRevisionDealIds(dealIds: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const id of dealIds) {
    if (seen.has(id)) ambiguous.add(id);
    seen.add(id);
  }
  return ambiguous;
}

function quantitiesDiffer(previous: string, next: string): boolean {
  const a = parseQuantity(previous);
  const b = parseQuantity(next);
  return a !== null && b !== null && a !== b;
}

function parseQuantity(value: string): number | null {
  const compact = value.replace(/[\s ]+/g, "").replace(",", ".");
  if (!compact) return null;
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\s ]+/g, "").replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTenge(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
}
