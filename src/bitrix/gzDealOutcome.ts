// Decides how a GZ plan deal ended from what the portal knows: a signed
// contract (and with whom) or, failing that, the plan point status. The
// decision is pure; scripts/check-gz-deal-outcomes.mts does the I/O.
//
// A customer may rewrite a plan point into a different item (a panel budget
// turned into skirting boards). The revision keeps the plan number, so a match
// through the plan number counts only when the item class is the same.

import { extractGzPlanPointIdFromUrl } from "../kz/gzPlanIdentity.js";

export interface GzOutcomeDealFields {
  TITLE?: string | null;
  ORIGIN_ID?: string | null;
  UF_CRM_PLAN_ID?: string | number | null;
  UF_CRM_1782386293000_IU_XLS?: string | number | null;
  UF_CRM_6A436D5A3614C?: string | number | null;
  UF_CRM_PLAN_LINK?: string | null;
  UF_CRM_1782386571874_IU_XLS?: string | null;
  UF_CRM_6627AEBD7C2D2?: string | null;
  UF_CRM_6A436D5A19612?: string | null;
  UF_CRM_REF_ENSTRU_CODE?: string | null;
  UF_CRM_6627AEBD54B8D?: string | null;
}

export interface GzOutcomeContractUnit {
  plnPointId?: number | null;
  totalSum?: number | null;
  /** The API sends a one-element list here, sometimes a plain string. */
  refEnstruCode?: string | string[] | null;
  Plans?: { rootrecordId?: number | null; nameRu?: string | null } | null;
}

export interface GzOutcomeContract {
  contractNumberSys?: string | null;
  signDate?: string | null;
  supplierBiin?: string | null;
  Supplier?: { nameRu?: string | null } | null;
  RefContractStatus?: { nameRu?: string | null } | null;
  deleted?: number | null;
  ContractUnits?: GzOutcomeContractUnit[] | GzOutcomeContractUnit | null;
}

/** Plan number is the root record of every revision of a plan point. */
export interface GzDealPlanRef {
  planNumber: number | null;
  pointIds: number[];
  /**
   * Other revisions of the plan number found in the registry. A contract unit
   * often points at one of them while its Plans link is empty, because the API
   * index lacks the revision. Weak evidence: a match needs the same item.
   */
  revisionIds: number[];
  /**
   * The plan number is confirmed by the deal's own point. Some deals carry a
   * wrong one (42445: a panel deal under an archive-services plan), so a
   * rewrite is claimed only when this is true.
   */
  planNumberVerified: boolean;
  /** ENSTRU code of the deal's item; old June deals have none. */
  enstruCode: string | null;
  itemName: string | null;
}

/** What the plan register says about the deal's point, already checked for the item. */
export interface GzPlanSignal {
  status: string | null;
  /** Item the point was rewritten into, when that is certain. */
  repurposedTo: string | null;
}

export interface GzOutcomeConfig {
  ourBins: string[];
  partnerBins: string[];
  itemFamilies: GzItemFamilies;
}

/**
 * ENSTRU code prefixes that sell as one product for us. One class can hold
 * unrelated items (262030 is both a panel and a paper shredder) and one
 * product can sit in several classes (LCD panel 279020, interactive 262030).
 */
export interface GzItemFamilies {
  groups: string[][];
  /** Wrapper items («Комплект учебного оборудования») that may hide any of ours. */
  wildcards: string[];
}

export type GzContractOutcomeKind = "won" | "lost" | "partner" | "terminated";
export type GzPlanOutcomeKind = "published" | "failed" | "cancelled" | "contract-draft" | "signed-unknown";

export type GzDealOutcome =
  | {
    kind: GzContractOutcomeKind;
    contractNumber: string;
    /** Date of the first version: supplementary agreements re-sign the contract. */
    signDate: string;
    supplierBin: string;
    supplierName: string;
    unitSum: number | null;
    /** Other live contracts bought the same point in parts. */
    otherContracts: number;
  }
  | { kind: GzPlanOutcomeKind; planStatus: string }
  | { kind: "repurposed"; newItem: string };

// «Изменен» marks a version superseded by a supplementary agreement.
const LIVE_CONTRACT_STATUSES = new Set(["действует", "исполнен", "передан.действует", "создано доп.соглашение"]);
const PLAN_STATUS_OUTCOMES: Record<string, GzPlanOutcomeKind> = {
  "опубликован": "published",
  "закупка не состоялась": "failed",
  "отменен": "cancelled",
  "отказ от закупки": "cancelled",
  "удален": "cancelled",
  "проект договора": "contract-draft",
  "договор действует": "signed-unknown",
  "исполнен": "signed-unknown",
  "срок договора истек": "signed-unknown"
};
// First 6 digits of an ENSTRU code name the item class; used only outside the families.
const ENSTRU_CLASS_LENGTH = 6;

/**
 * Deals from different months carry the plan identity in different fields;
 * June deals even hold the plan *list* id in ORIGIN_ID, so the URL wins.
 */
export function buildGzDealPlanRef(deal: GzOutcomeDealFields): GzDealPlanRef {
  const title = String(deal.TITLE ?? "").trim();
  const planNumber = positiveInt(deal.UF_CRM_PLAN_ID)
    ?? positiveInt(deal.UF_CRM_1782386293000_IU_XLS)
    ?? positiveInt(/\[GZ (\d+)\]/.exec(title)?.[1]);
  const urlPoints = [deal.UF_CRM_PLAN_LINK, deal.UF_CRM_1782386571874_IU_XLS]
    .map((url) => positiveInt(extractGzPlanPointIdFromUrl(url)));
  // Old deals keep the plan list id in the point field; it can collide with a
  // real point of another year (deal 26239: list 4755430 = a 2016 brake disc).
  const fromUrl = urlPoints.filter((id): id is number => id !== null);
  const fieldPoint = fromUrl.length === 0 ? positiveInt(deal.UF_CRM_6A436D5A3614C) : null;
  const known = fieldPoint === null ? fromUrl : [fieldPoint];
  const originPoint = known.length === 0 ? positiveInt(String(deal.ORIGIN_ID ?? "").split(":")[1]) : null;
  // Bitrix returns an empty custom field as "", so `??` would stop at it.
  const code = String(deal.UF_CRM_6A436D5A19612 || deal.UF_CRM_REF_ENSTRU_CODE || "").trim();
  // June deals were titled with the bare item name.
  const itemName = String(deal.UF_CRM_6627AEBD54B8D ?? "").trim() || (title && !title.includes("[GZ") ? title : "");
  return {
    planNumber,
    pointIds: [...new Set(originPoint === null ? known : [...known, originPoint])],
    revisionIds: [],
    planNumberVerified: planNumber !== null && known.includes(planNumber),
    enstruCode: /^\d{6}/.test(code) ? code : null,
    itemName: itemName || null
  };
}

export function dealBin(deal: GzOutcomeDealFields): string | null {
  const digits = String(deal.UF_CRM_6627AEBD7C2D2 ?? "").replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
}

/**
 * true / false when the items can be compared, null when they cannot. Codes
 * decide whenever both sides have one: first words like «Панель» or
 * «Комплект» are shared by unrelated items.
 */
export function isSameGzItem(
  ref: GzDealPlanRef,
  enstruCode: string | null | undefined,
  name: string | null | undefined,
  families: GzItemFamilies
): boolean | null {
  const code = String(enstruCode ?? "").trim();
  if (ref.enstruCode && /^\d{6}/.test(code)) return sameByCode(ref.enstruCode, code, families);
  const a = firstWord(ref.itemName);
  const b = firstWord(name);
  return a && b ? a === b : null;
}

const CONTRACT_OUTCOME_PREFIXES = ["won:", "lost:", "partner:", "repurposed:"];

/**
 * Whether a newly computed key may replace the one stored on the deal. A
 * settled outcome (who signed, or a rewritten point) is never downgraded to a
 * plan status: that only happens when the contract fetch hiccups, and would
 * re-post the same news on the next run. A terminated contract stays open to
 * whatever comes next, a re-announcement included.
 */
export function shouldReplaceGzOutcomeKey(storedKey: string | null | undefined, nextKey: string): boolean {
  const stored = String(storedKey ?? "").trim();
  if (stored === nextKey) return false;
  const settled = CONTRACT_OUTCOME_PREFIXES.some((prefix) => stored.startsWith(prefix));
  const nextSettled = CONTRACT_OUTCOME_PREFIXES.some((prefix) => nextKey.startsWith(prefix))
    || nextKey.startsWith("terminated:");
  return !settled || nextSettled;
}

function sameByCode(a: string, b: string, families: GzItemFamilies): boolean {
  const isWildcard = (code: string) => families.wildcards.some((prefix) => code.startsWith(prefix));
  if (isWildcard(a) || isWildcard(b)) return true;
  const groupsOf = (code: string) => families.groups
    .map((group, index) => (group.some((prefix) => code.startsWith(prefix)) ? index : -1))
    .filter((index) => index >= 0);
  const groupsA = groupsOf(a);
  const groupsB = groupsOf(b);
  if (groupsA.length > 0 || groupsB.length > 0) return groupsA.some((index) => groupsB.includes(index));
  return a.slice(0, ENSTRU_CLASS_LENGTH) === b.slice(0, ENSTRU_CLASS_LENGTH);
}

/**
 * Plan register status for the deal. A revision found by plan number is
 * trusted only for the same item; a rewrite is reported only for deals whose
 * ENSTRU code makes the comparison certain.
 */
export function readGzPlanSignal(
  ref: GzDealPlanRef,
  plan: { status: string | null; enstruCode?: string | null; name?: string | null; exactPoint: boolean } | null,
  families: GzItemFamilies
): GzPlanSignal {
  if (!plan) return { status: null, repurposedTo: null };
  if (plan.exactPoint) return { status: plan.status, repurposedTo: null };
  const same = isSameGzItem(ref, plan.enstruCode, plan.name, families);
  if (same) return { status: plan.status, repurposedTo: null };
  const certain = same === false && ref.planNumberVerified && ref.enstruCode !== null
    && /^\d{6}/.test(String(plan.enstruCode ?? ""));
  return { status: null, repurposedTo: certain ? String(plan.name ?? "").trim() || null : null };
}

/** The plan register says a contract exists or is being drafted. */
export function isSignedGzPlanStatus(status: string | null | undefined): boolean {
  const kind = PLAN_STATUS_OUTCOMES[normalize(status)];
  return kind === "signed-unknown" || kind === "contract-draft";
}

export function findPlanContracts(
  ref: GzDealPlanRef,
  contracts: readonly GzOutcomeContract[],
  families: GzItemFamilies
): GzOutcomeContract[] {
  return contracts.filter((contract) => !contract.deleted && matchingUnits(ref, contract, families).length > 0);
}

export function decideGzDealOutcome(
  ref: GzDealPlanRef,
  contracts: readonly GzOutcomeContract[],
  plan: GzPlanSignal,
  config: GzOutcomeConfig
): GzDealOutcome | null {
  return decideContractOutcome(ref, findPlanContracts(ref, contracts, config.itemFamilies), config)
    ?? (plan.repurposedTo ? { kind: "repurposed", newItem: plan.repurposedTo } : null)
    ?? repurposedByContract(ref, contracts, config.itemFamilies)
    ?? decidePlanStatusOutcome(plan.status);
}

export function gzDealOutcomeKey(outcome: GzDealOutcome): string {
  if ("contractNumber" in outcome) return `${outcome.kind}:${outcome.contractNumber}`;
  if ("newItem" in outcome) return `${outcome.kind}:${normalize(outcome.newItem)}`;
  return `${outcome.kind}:${normalize(outcome.planStatus)}`;
}

export function buildGzDealOutcomeComment(outcome: GzDealOutcome, planUrl: string | null): string {
  const link = planUrl ? `\n${planUrl}` : "";
  if ("newItem" in outcome) {
    return `Итог закупки: заказчик переделал пункт плана под другой товар («${outcome.newItem}») — по этому плану закупки не будет.${link}`;
  }
  if (!("contractNumber" in outcome)) return buildPlanStatusComment(outcome.kind, outcome.planStatus, link);

  const contract = `договор №${outcome.contractNumber} от ${formatDate(outcome.signDate)}`;
  const sum = outcome.unitSum ? `, ${formatTenge(outcome.unitSum)} ₸` : "";
  const others = outcome.otherContracts > 0 ? ` (по этому пункту есть ещё договоров: ${outcome.otherContracts})` : "";
  const supplier = `${outcome.supplierName} (БИН ${outcome.supplierBin})`;
  switch (outcome.kind) {
    case "won":
      return `Итог закупки: договор подписан с нами — ${contract}${sum}${others}.\nОтметьте победу в сделке.`;
    case "partner":
      return `Итог закупки: выиграл наш партнёр ${supplier} — ${contract}${sum}${others}.`;
    case "lost":
      return `Итог закупки: выиграл ${supplier} — ${contract}${sum}${others}.\nЕсли сделка ещё открыта, закройте её как «Закупка состоялась».`;
    case "terminated":
      return `Итог закупки: ${contract} с ${supplier} расторгнут.\nЗаказчик может объявить закупку заново — не теряйте его.`;
  }
}

/** "990340007507/260547/01" → "990340007507/260547". */
export function contractBaseNumber(contractNumber: string): string {
  const parts = contractNumber.trim().split("/");
  return parts.length > 2 ? parts.slice(0, -1).join("/") : parts.join("/");
}

function decideContractOutcome(
  ref: GzDealPlanRef,
  contracts: readonly GzOutcomeContract[],
  config: GzOutcomeConfig
): GzDealOutcome | null {
  const live = contracts.filter((contract) => LIVE_CONTRACT_STATUSES.has(normalize(contract.RefContractStatus?.nameRu)));
  if (live.length === 0) {
    const terminated = latest(contracts.filter((contract) => normalize(contract.RefContractStatus?.nameRu).startsWith("расторгнут")));
    return terminated ? contractOutcome("terminated", terminated, ref, contracts, 0, config.itemFamilies) : null;
  }

  // One live version per contract; the point may be split across several contracts.
  const byBase = new Map<string, GzOutcomeContract>();
  for (const contract of live) {
    const base = contractBaseNumber(String(contract.contractNumberSys ?? ""));
    const known = byBase.get(base);
    if (!known || String(contract.signDate ?? "") > String(known.signDate ?? "")) byBase.set(base, contract);
  }
  const groups = [...byBase.values()];
  const ours = groups.find((contract) => config.ourBins.includes(supplierBinOf(contract)));
  const sumOf = (contract: GzOutcomeContract) => unitSum(ref, contract, config.itemFamilies);
  // Ties fall to the earliest contract so the outcome key stays the same run after run.
  const chosen = ours ?? [...groups].sort((a, b) => sumOf(b) - sumOf(a)
    || String(a.signDate ?? "").localeCompare(String(b.signDate ?? ""))
    || String(a.contractNumberSys ?? "").localeCompare(String(b.contractNumberSys ?? "")))[0];
  const bin = supplierBinOf(chosen);
  const kind: GzContractOutcomeKind = ours ? "won" : config.partnerBins.includes(bin) ? "partner" : "lost";
  return contractOutcome(kind, chosen, ref, contracts, groups.length - 1, config.itemFamilies);
}

function contractOutcome(
  kind: GzContractOutcomeKind,
  chosen: GzOutcomeContract,
  ref: GzDealPlanRef,
  contracts: readonly GzOutcomeContract[],
  otherContracts: number,
  families: GzItemFamilies
): GzDealOutcome {
  const baseNumber = contractBaseNumber(String(chosen.contractNumberSys ?? ""));
  const versions = contracts.filter((contract) => contractBaseNumber(String(contract.contractNumberSys ?? "")) === baseNumber);
  const supplierBin = supplierBinOf(chosen);
  const sum = unitSum(ref, chosen, families);
  return {
    kind,
    contractNumber: baseNumber,
    signDate: earliestDate(versions) ?? "",
    supplierBin,
    supplierName: String(chosen.Supplier?.nameRu ?? "").trim() || supplierBin,
    unitSum: sum > 0 ? sum : null,
    otherContracts
  };
}

/** A live contract for a rewritten point proves the rewrite even without the plan register. */
function repurposedByContract(
  ref: GzDealPlanRef,
  contracts: readonly GzOutcomeContract[],
  families: GzItemFamilies
): GzDealOutcome | null {
  if (!ref.enstruCode || !ref.planNumberVerified) return null;
  for (const contract of contracts) {
    if (contract.deleted || !LIVE_CONTRACT_STATUSES.has(normalize(contract.RefContractStatus?.nameRu))) continue;
    for (const unit of units(contract)) {
      const code = unitCode(unit);
      // Registry rows are not proof of lineage; only the API root link is.
      if (!isRootRevisionOf(ref, unit) || !/^\d{6}/.test(code)) continue;
      if (isSameGzItem(ref, code, unit.Plans?.nameRu, families) === false) {
        const newItem = String(unit.Plans?.nameRu || code).trim();
        return { kind: "repurposed", newItem };
      }
    }
  }
  return null;
}

function decidePlanStatusOutcome(planStatus: string | null): GzDealOutcome | null {
  const kind = PLAN_STATUS_OUTCOMES[normalize(planStatus)];
  return kind && planStatus ? { kind, planStatus: planStatus.trim() } : null;
}

function buildPlanStatusComment(kind: GzPlanOutcomeKind, planStatus: string, link: string): string {
  switch (kind) {
    case "published":
      return `Итог закупки: объявление по плану опубликовано — успейте подать заявку.${link}`;
    case "failed":
      return `Итог закупки: закупка не состоялась. Заказчик, скорее всего, объявит её повторно или купит из одного источника.${link}`;
    case "cancelled":
      return `Итог закупки: заказчик отказался от закупки (статус плана «${planStatus}»).${link}`;
    case "contract-draft":
      return `Итог закупки: победитель определён, договор на стадии проекта и ещё не подписан. Когда его подпишут, робот напишет, с кем.${link}`;
    case "signed-unknown":
      return `Итог закупки: по плану уже заключён договор (статус «${planStatus}»), победителя определить не удалось — проверьте на портале.${link}`;
  }
}

function matchingUnits(ref: GzDealPlanRef, contract: GzOutcomeContract, families: GzItemFamilies): GzOutcomeContractUnit[] {
  return units(contract).filter((unit) => {
    if (unit.plnPointId != null && ref.pointIds.includes(unit.plnPointId)) return true;
    const registryRevision = unit.plnPointId != null && ref.revisionIds.includes(unit.plnPointId);
    return (registryRevision || isRootRevisionOf(ref, unit))
      && isSameGzItem(ref, unitCode(unit), unit.Plans?.nameRu, families) === true;
  });
}

function isRootRevisionOf(ref: GzDealPlanRef, unit: GzOutcomeContractUnit): boolean {
  if (ref.planNumber === null) return false;
  return unit.plnPointId === ref.planNumber || unit.Plans?.rootrecordId === ref.planNumber;
}

function unitCode(unit: GzOutcomeContractUnit): string {
  const code = Array.isArray(unit.refEnstruCode) ? unit.refEnstruCode[0] : unit.refEnstruCode;
  return String(code ?? "").trim();
}

function units(contract: GzOutcomeContract): GzOutcomeContractUnit[] {
  if (Array.isArray(contract.ContractUnits)) return contract.ContractUnits;
  return contract.ContractUnits ? [contract.ContractUnits] : [];
}

function unitSum(ref: GzDealPlanRef, contract: GzOutcomeContract, families: GzItemFamilies): number {
  return matchingUnits(ref, contract, families).reduce((sum, unit) => sum + (unit.totalSum ?? 0), 0);
}

function supplierBinOf(contract: GzOutcomeContract): string {
  return String(contract.supplierBiin ?? "").trim();
}

function latest(contracts: readonly GzOutcomeContract[]): GzOutcomeContract | null {
  return [...contracts].sort((a, b) => String(b.signDate ?? "").localeCompare(String(a.signDate ?? "")))[0] ?? null;
}

function earliestDate(contracts: readonly GzOutcomeContract[]): string | null {
  const dates = contracts.map((contract) => String(contract.signDate ?? "").slice(0, 10)).filter(Boolean).sort();
  return dates[0] ?? null;
}

function firstWord(value: string | null | undefined): string {
  return normalize(value).split(/[^\p{L}\p{N}]+/u).find(Boolean) ?? "";
}

function positiveInt(value: string | number | null | undefined): number | null {
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/ё/g, "е");
}

function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : isoDate;
}

function formatTenge(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
}
