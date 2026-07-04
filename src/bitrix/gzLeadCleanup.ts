export const GZ_ORIGINATOR_ID = "scrape2lead-gz-plans";

export interface BitrixUserSummary {
  ID?: string | number;
  NAME?: string | null;
  LAST_NAME?: string | null;
  SECOND_NAME?: string | null;
  ACTIVE?: boolean | string | null;
}

export interface BitrixLeadCleanupCandidate {
  ID?: string | number;
  TITLE?: string | null;
  ORIGINATOR_ID?: string | null;
  ORIGIN_ID?: string | null;
  ASSIGNED_BY_ID?: string | number | null;
  DATE_CREATE?: string | null;
  DATE_MODIFY?: string | null;
}

export function normalizePersonName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

export function formatBitrixUserName(user: BitrixUserSummary): string {
  return [user.NAME, user.LAST_NAME].filter(Boolean).join(" ").trim();
}

export function findExactUsersByName(users: BitrixUserSummary[], fullName: string): BitrixUserSummary[] {
  const target = normalizePersonName(fullName);
  return users.filter((user) => {
    const active = user.ACTIVE;
    if (active === false || active === "N") return false;
    return normalizePersonName(formatBitrixUserName(user)) === target;
  });
}

export function isGzOriginId(value: string | null | undefined): boolean {
  return /^gz-plan:\d+$/.test(value ?? "");
}

export function isSafeGzLeadForAssignee(lead: BitrixLeadCleanupCandidate, assigneeId: string): boolean {
  return String(lead.ORIGINATOR_ID ?? "") === GZ_ORIGINATOR_ID
    && isGzOriginId(lead.ORIGIN_ID)
    && String(lead.ASSIGNED_BY_ID ?? "") === assigneeId;
}

export function buildGzLeadCleanupFilter(assigneeId: string): Record<string, string> {
  return {
    ORIGINATOR_ID: GZ_ORIGINATOR_ID,
    ASSIGNED_BY_ID: assigneeId
  };
}
