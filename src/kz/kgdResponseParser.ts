import type { CounterpartyPayloadResult, VatStatus } from "./kgdCounterpartyTypes.js";

type Payload = Record<string, unknown>;
const truthy = (value: unknown): boolean => value === true || value === 1 || /^(true|yes|да|1)$/i.test(String(value ?? ""));
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export function parseCounterpartyPayload(input: unknown): CounterpartyPayloadResult {
  const p = unwrap(input);
  const vatPayer = truthy(first(p, "vatPayer", "isVatPayer", "ndsPayer"));
  const vatRemoved = truthy(first(p, "vatRemoved", "isVatRemoved")) || /снят/i.test(text(first(p, "vatStatus", "ndsStatus")));
  const never = truthy(first(p, "neverVatRegistered", "neverRegisteredVat")) || /никогда.*не состоял/i.test(text(first(p, "vatStatus", "ndsStatus")));
  const removedAt = normalizeDate(first(p, "vatRemovedAt", "vatRemovalDate", "ndsEndDate"));
  const registeredAt = normalizeDate(first(p, "vatRegisteredAt", "vatRegistrationDate", "ndsStartDate"));
  let status: VatStatus["status"] = "unknown";
  if (vatPayer && vatRemoved) status = "contradictory"; else if (vatRemoved) status = "removed"; else if (never) status = "never_registered"; else if (vatPayer) status = "registered";
  const flags: Array<[string, string[]]> = [
    ["недействительная регистрация/перерегистрация", ["invalidRegistration", "invalidReregistration"]],
    ["операции без фактического выполнения", ["transactionsWithoutActualPerformance", "noActualOperations"]],
    ["бездействие", ["inactivity", "inactiveTaxpayer"]],
    ["отсутствие по юридическому адресу", ["absentAtLegalAddress", "noLegalAddress"]]
  ];
  const reasons = flags.filter(([, keys]) => keys.some((key) => truthy(p[key]))).map(([label]) => label);
  return { bin: text(first(p, "bin", "iinBin", "taxpayerBin")), name: text(first(p, "name", "taxpayerName", "nameRu")), vat: { status, ...(registeredAt ? { registeredAt } : {}), ...(removedAt ? { removedAt } : {}) }, bankruptcy: truthy(first(p, "bankruptcy", "isBankrupt")), esfRestricted: truthy(first(p, "esfRestrinctions", "esfRestrictions", "esfRestricted")), unreliable: reasons.length > 0, unreliableReasons: reasons };
}

export function parseLiquidationPayload(input: unknown): { active: boolean; startDate?: string } {
  const p = unwrap(input); const active = truthy(first(p, "isLiquidated", "liquidation", "onLiquidationStage")); const date = normalizeDate(first(p, "liquidationStartDate", "startDate", "dateBegin"));
  return { active, ...(date ? { startDate: date } : {}) };
}

function unwrap(input: unknown): Payload { if (!input || typeof input !== "object") return {}; const p = input as Payload; for (const key of ["data", "result", "taxpayer"]) if (p[key] && typeof p[key] === "object" && !Array.isArray(p[key])) return p[key] as Payload; return p; }
function first(p: Payload, ...keys: string[]): unknown { return keys.map((key) => p[key]).find((v) => v !== undefined && v !== null); }
export function normalizeDate(value: unknown): string | undefined { const s = text(value); if (!s) return undefined; const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/); if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`; const iso = s.match(/^\d{4}-\d{2}-\d{2}/); return iso?.[0]; }
