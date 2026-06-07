import { goszakupGetJson, type GoszakupClientOptions } from "./goszakupClient.js";

const DEFAULT_ACTIVE_IDS = new Set([210, 220]);

let cachedStatusMap: Map<number, string> | null = null;

export async function loadBuyStatusRef(
  options: GoszakupClientOptions
): Promise<Map<number, string>> {
  if (cachedStatusMap) return cachedStatusMap;

  try {
    const payload = await goszakupGetJson("/v3/refs/ref_buy_status", options) as unknown;
    const map = parseStatusRef(payload);
    if (map.size > 0) {
      cachedStatusMap = map;
      return map;
    }
  } catch (err) {
    console.warn("goszakup.gov.kz: failed to load status ref:", err instanceof Error ? err.message : String(err));
  }

  return new Map();
}

export function resetStatusRefCache(): void {
  cachedStatusMap = null;
}

export function getActiveStatusIds(): Set<number> {
  const override = process.env.GOSZAKUP_ACTIVE_STATUS_IDS;
  if (override) {
    const ids = override.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (ids.length > 0) return new Set(ids);
  }
  return DEFAULT_ACTIVE_IDS;
}

export function isActiveBuyStatus(statusId: number | null, activeIds?: Set<number>): boolean {
  if (statusId == null) return false;
  return (activeIds ?? getActiveStatusIds()).has(statusId);
}

export function resolveBuyStatusName(statusId: number, statusMap: Map<number, string>): string {
  return statusMap.get(statusId) ?? String(statusId);
}

function parseStatusRef(payload: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!payload || typeof payload !== "object") return map;

  const data = Array.isArray(payload) ? payload : (payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).items ?? [];
  if (!Array.isArray(data)) return map;

  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const id = Number(obj.id ?? obj.ref_buy_status_id ?? obj.code);
    const name = String(obj.name_ru ?? obj.name ?? obj.title ?? "");
    if (!Number.isNaN(id) && name) {
      map.set(id, name);
    }
  }
  return map;
}
