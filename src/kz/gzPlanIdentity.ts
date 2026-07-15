const SHOW_PLAN_PATH = /^\/ru\/registry\/show_plan\/(\d+)(?:\/(\d+))?\/?$/i;

export interface GzPlanLinkIdentity {
  planPointId: string;
  legacyPlanId: string | null;
}

export function parseGzPlanLinkIdentity(value: string | null | undefined): GzPlanLinkIdentity | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLocaleLowerCase("en");
    if (hostname !== "goszakup.gov.kz" && !hostname.endsWith(".goszakup.gov.kz")) return null;
    const match = url.pathname.match(SHOW_PLAN_PATH);
    if (!match) return null;
    return {
      planPointId: match[1],
      legacyPlanId: match[2] ?? null
    };
  } catch {
    return null;
  }
}

export function extractGzPlanPointIdFromUrl(value: string | null | undefined): string | null {
  return parseGzPlanLinkIdentity(value)?.planPointId ?? null;
}

export function extractLegacyGzPlanIdFromUrl(value: string | null | undefined): string | null {
  return parseGzPlanLinkIdentity(value)?.legacyPlanId ?? null;
}

export function resolveGzPlanPointId(planUrl: string, fallbackPlanId: string): string | null {
  return extractGzPlanPointIdFromUrl(planUrl) ?? normalizeNumericId(fallbackPlanId);
}

export function buildGzPlanOriginId(planPointId: string): string {
  return `gz-plan:${planPointId}`;
}

function normalizeNumericId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^\d+$/.test(normalized) ? normalized : null;
}
