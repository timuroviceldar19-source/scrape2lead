import type { EnrichError } from "./tenderTypes.js";

/** Keep the latest enrich error per BIN + stage. */
export function dedupeEnrichErrors(errors: EnrichError[], bins?: string[]): EnrichError[] {
  let filtered = errors;
  if (bins && bins.length > 0) {
    const allowed = new Set(bins);
    filtered = errors.filter((error) => allowed.has(error.bin));
  }

  const latestByKey = new Map<string, EnrichError>();
  for (const error of filtered) {
    const key = `${error.bin}\0${error.stage}`;
    const existing = latestByKey.get(key);
    if (!existing || error.id > existing.id) {
      latestByKey.set(key, error);
    }
  }

  return Array.from(latestByKey.values()).sort((a, b) => b.id - a.id);
}

export function isStatGovMissingForCard(input: {
  participant_id?: string | null;
  registry_phone?: string | null;
  oked?: string | null;
}): boolean {
  const hasRegistry = Boolean(input.participant_id || input.registry_phone);
  const hasStatOked = Boolean(input.oked && String(input.oked).trim());
  return hasRegistry && !hasStatOked;
}
