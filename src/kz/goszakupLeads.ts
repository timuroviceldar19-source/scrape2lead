export interface LeadContract {
  bin: string;
  supplierName: string;
  signedAt: string;
  contractId: string;
  contractNumber: string;
  customerName: string;
  customerBin: string;
  amount: number;
  searchCode: string;
}

export interface LeadRegistryRecord {
  bin: string;
  nameRu: string | null;
  phone: string | null;
  fullAddressRu: string | null;
  legalAddress: string | null;
  locationAddress: string | null;
  economicSector: string | null;
  okedList: string | null;
  registryUrl: string | null;
}

export interface GoszakupLeadCandidate {
  bin: string;
  name: string;
  phone: string | null;
  phoneOk: boolean;
  city: "Астана" | "Алматы" | "Другой город";
  economicSector: string | null;
  okedList: string | null;
  currentContracts: number;
  currentAmount: number;
  lastSignedAt: string;
  lastContractNumber: string;
  lastCustomerName: string;
  lastCustomerBin: string;
  registryUrl: string | null;
  signal: "active" | "dormant";
}

export interface LeadSelectionResult {
  candidates: GoszakupLeadCandidate[];
  phoneLeads: GoszakupLeadCandidate[];
  callLeads: GoszakupLeadCandidate[];
  otherCityLeads: GoszakupLeadCandidate[];
  withoutPhoneLeads: GoszakupLeadCandidate[];
}

export function normalizeLeadPhone(raw: string | null | undefined): { phone: string | null; phoneOk: boolean } {
  if (!raw) return { phone: null, phoneOk: false };
  for (const rawCandidate of raw.split(/[,;/]/)) {
    const digits = rawCandidate.replace(/\D/g, "");
    const normalized = normalizeDigits(digits);
    if (!normalized || isObviousPhoneJunk(normalized)) continue;
    return { phone: normalized, phoneOk: true };
  }
  return { phone: null, phoneOk: false };
}

export function detectLeadCity(addresses: {
  fullAddressRu?: string | null;
  legalAddress?: string | null;
  locationAddress?: string | null;
}): "Астана" | "Алматы" | "Другой город" {
  const address = addresses.fullAddressRu ?? addresses.legalAddress ?? addresses.locationAddress ?? "";
  const normalized = address.toLocaleLowerCase("ru-RU");
  if (/(?:астана|astana|nur[ -]?sultan|нур[ -]?султан)/i.test(normalized)) return "Астана";
  if (/(?:алматы|almaty)/i.test(normalized)) return "Алматы";
  return "Другой город";
}

export function buildGoszakupLeadCandidates(input: {
  now: Date;
  currentFrom: string;
  historyFrom: string;
  contracts: LeadContract[];
  registryByBin: ReadonlyMap<string, LeadRegistryRecord>;
  callLimit?: number;
}): LeadSelectionResult {
  const groups = new Map<string, LeadContract[]>();
  for (const contract of input.contracts) {
    if (!/^\d{12}$/.test(contract.bin) || contract.signedAt < input.historyFrom) continue;
    const contracts = groups.get(contract.bin) ?? [];
    contracts.push(contract);
    groups.set(contract.bin, contracts);
  }

  const candidates: GoszakupLeadCandidate[] = [];
  for (const [bin, contracts] of groups) {
    const ordered = [...contracts].sort(compareContractFreshness);
    const currentContracts = ordered.filter((contract) => contract.signedAt >= input.currentFrom);
    const last = ordered[0];
    if (!last) continue;
    const withinEighteenMonths = last.signedAt >= isoMonthsAgo(input.now, 18);
    const signal = currentContracts.length >= 3 ? "active" : currentContracts.length === 0 && withinEighteenMonths ? "dormant" : null;
    if (!signal) continue;

    const registry = input.registryByBin.get(bin);
    const phone = normalizeLeadPhone(registry?.phone);
    candidates.push({
      bin,
      name: registry?.nameRu?.trim() || last.supplierName,
      phone: phone.phone,
      phoneOk: phone.phoneOk,
      city: detectLeadCity(registry ?? {}),
      economicSector: registry?.economicSector ?? null,
      okedList: registry?.okedList ?? null,
      currentContracts: currentContracts.length,
      currentAmount: currentContracts.reduce((total, contract) => total + contract.amount, 0),
      lastSignedAt: last.signedAt,
      lastContractNumber: last.contractNumber,
      lastCustomerName: last.customerName,
      lastCustomerBin: last.customerBin,
      registryUrl: registry?.registryUrl ?? null,
      signal
    });
  }

  const sorted = candidates.sort(compareCandidates);
  const phoneLeads = dedupeByPhone(sorted.filter((candidate) => candidate.phoneOk));
  const priorityCityLeads = phoneLeads.filter((candidate) => candidate.city !== "Другой город");
  const callLeads = input.callLimit === undefined ? priorityCityLeads : priorityCityLeads.slice(0, input.callLimit);
  return {
    candidates: sorted,
    phoneLeads,
    callLeads,
    otherCityLeads: phoneLeads.filter((candidate) => candidate.city === "Другой город"),
    withoutPhoneLeads: sorted.filter((candidate) => !candidate.phoneOk)
  };
}

function normalizeDigits(digits: string): string | null {
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return null;
}

function isObviousPhoneJunk(phone: string): boolean {
  const national = phone.slice(2);
  return /^([0-9])\1{9}$/.test(national) || national === "0000000000";
}

function compareContractFreshness(left: LeadContract, right: LeadContract): number {
  return right.signedAt.localeCompare(left.signedAt) || right.contractId.localeCompare(left.contractId);
}

function compareCandidates(left: GoszakupLeadCandidate, right: GoszakupLeadCandidate): number {
  const rank = (candidate: GoszakupLeadCandidate) => candidate.signal === "active" ? 0 : 1;
  return rank(left) - rank(right)
    || right.currentContracts - left.currentContracts
    || right.lastSignedAt.localeCompare(left.lastSignedAt)
    || right.currentAmount - left.currentAmount
    || left.bin.localeCompare(right.bin);
}

function dedupeByPhone(candidates: GoszakupLeadCandidate[]): GoszakupLeadCandidate[] {
  const byPhone = new Map<string, GoszakupLeadCandidate>();
  for (const candidate of candidates) {
    if (!candidate.phone || !byPhone.has(candidate.phone)) byPhone.set(candidate.phone ?? candidate.bin, candidate);
  }
  return [...byPhone.values()].sort(compareCandidates);
}

function isoMonthsAgo(now: Date, months: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return date.toISOString().slice(0, 10);
}
