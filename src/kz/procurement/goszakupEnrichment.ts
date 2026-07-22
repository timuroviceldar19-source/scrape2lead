import type { ProcurementRecord } from "./types.js";

export interface GoszakupEnrichmentCandidate {
  upstreamKey?: string | null;
  customerName?: string | null;
  bin?: string | null;
  truCode?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  reportingAdministrator?: string | null;
  legalAddress?: string | null;
  directorName?: string | null;
}

export function applyGoszakupEnrichmentCandidates(
  records: ProcurementRecord[],
  candidates: GoszakupEnrichmentCandidate[]
): ProcurementRecord[] {
  const byUpstream = new Map(candidates.filter((item) => item.upstreamKey).map((item) => [item.upstreamKey as string, item]));
  const byBin = new Map(candidates.filter((item) => validBin(item.bin)).map((item) => [validBin(item.bin) as string, item]));
  const byName = groupUniqueNames(candidates);

  return records.map((record) => {
    const registry = record.customerBin ? byBin.get(record.customerBin) : null;
    const withProfile: ProcurementRecord = registry ? { ...record, customerProfile: {
      source: "goszakup", website: text(registry.website), email: text(registry.email), phone: text(registry.phone),
      reportingAdministrator: text(registry.reportingAdministrator), fullAddress: text(registry.legalAddress),
      directorName: text(registry.directorName)
    } } : record;
    const exact = byUpstream.get(recordKey(withProfile));
    if (exact) {
      const bin = validBin(exact.bin);
      const truCode = text(exact.truCode);
      if (bin || truCode) return {
        ...withProfile,
        customerBin: withProfile.customerBin ?? bin,
        truCode: withProfile.truCode ?? truCode,
        enrichment: { source: "goszakup", confidence: "exact" }
      };
    }

    if (withProfile.customerBin || withProfile.enrichment?.confidence === "exact") return withProfile;
    const name = normalizeName(withProfile.customerName);
    const candidate = name ? byName.get(name) : null;
    if (!candidate) return withProfile;
    const candidateBin = validBin(candidate.bin);
    const candidateTruCode = text(candidate.truCode);
    if (!candidateBin && !candidateTruCode) return withProfile;
    return { ...withProfile, enrichment: {
      source: "goszakup", confidence: "candidate", candidateBin, candidateTruCode
    } };
  });
}

function groupUniqueNames(candidates: GoszakupEnrichmentCandidate[]): Map<string, GoszakupEnrichmentCandidate> {
  const grouped = new Map<string, GoszakupEnrichmentCandidate[]>();
  for (const candidate of candidates) {
    const name = normalizeName(candidate.customerName);
    if (!name) continue;
    grouped.set(name, [...(grouped.get(name) ?? []), candidate]);
  }
  const unique = new Map<string, GoszakupEnrichmentCandidate>();
  for (const [name, matches] of grouped) {
    const identities = new Set(matches.map((item) => `${validBin(item.bin) ?? ""}|${text(item.truCode) ?? ""}`));
    if (identities.size === 1) unique.set(name, matches[0] as GoszakupEnrichmentCandidate);
  }
  return unique;
}

function recordKey(record: ProcurementRecord): string { return `${record.source}:${record.recordKind}:${record.externalId}`; }
function normalizeName(value: unknown): string { return text(value)?.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim() ?? ""; }
function validBin(value: unknown): string | null { const digits = text(value)?.replace(/\D/g, "") ?? ""; return digits.length === 12 ? digits : null; }
function text(value: unknown): string | null { const result = value === null || value === undefined ? "" : String(value).trim(); return result || null; }
