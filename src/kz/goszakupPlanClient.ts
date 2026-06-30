import { goszakupGetJson } from "./goszakupClient.js";
import type { GoszakupPlanDetail } from "./goszakupPlanTypes.js";

export interface GoszakupPlanClientOptions {
  token: string;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

interface V2PageResponse {
  total?: number;
  limit?: number;
  next_page?: string;
  items?: Array<Record<string, unknown>>;
}

interface AbpRefItem {
  id?: number | string;
  name_ru?: string | null;
  name_kz?: string | null;
}

export async function fetchPlanDetailFromApi(
  planPointId: string,
  options: GoszakupPlanClientOptions
): Promise<GoszakupPlanDetail | null> {
  try {
    const payload = await goszakupGetJson(`/v2/plans/view/${planPointId}`, options) as Record<string, unknown>;
    return mapApiPlanDetail(planPointId, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`goszakup plan api: view/${planPointId} failed: ${message}`);
    return null;
  }
}

export async function loadAbpRefs(options: GoszakupPlanClientOptions): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  let nextPath: string | null = "/v2/refs/ref_abp";
  let pages = 0;

  while (nextPath && pages < 50) {
    pages++;
    const payload = await goszakupGetJson(nextPath, options) as V2PageResponse;
    if (Array.isArray(payload.items)) {
      for (const item of payload.items) {
        const id = item.id;
        const name = typeof item.name_ru === "string" ? item.name_ru : null;
        if (id != null && name) {
          refs.set(String(id), name);
        }
      }
    }
    nextPath = typeof payload.next_page === "string" && payload.next_page.trim() !== ""
      ? payload.next_page
      : null;
  }

  return refs;
}

export function mapApiPlanDetail(planPointId: string, payload: Record<string, unknown>): GoszakupPlanDetail {
  const kato = Array.isArray(payload.kato) ? payload.kato as Array<Record<string, unknown>> : [];
  const deliveryAddress = kato
    .map((entry) => typeof entry.full_delivery_place_name_ru === "string" ? entry.full_delivery_place_name_ru : null)
    .filter(Boolean)
    .join("; ");

  const descRu = stringValue(payload.desc_ru);
  const extraDescRu = stringValue(payload.extra_desc_ru);

  return {
    plan_point_id: planPointId,
    customer_bin: normalizeBin(stringValue(payload.subject_biin)),
    customer_name: stringValue(payload.name_ru) ?? stringValue(payload.customer_name_ru),
    name_ru: stringValue(payload.name_ru),
    ref_enstru_code: stringValue(payload.ref_enstru_code),
    desc_ru: descRu,
    extra_desc_ru: extraDescRu,
    date_approved: normalizeApiDate(stringValue(payload.date_approved)),
    ref_abp_code: payload.ref_abp_code != null ? String(payload.ref_abp_code) : null,
    abp_name: null,
    delivery_address: deliveryAddress || null,
    plan_act_number: stringValue(payload.plan_act_number)
  };
}

export function resolveAbpName(
  detail: GoszakupPlanDetail,
  abpRefs: Map<string, string>
): string | null {
  if (detail.abp_name) return detail.abp_name;
  if (!detail.ref_abp_code) return null;
  return abpRefs.get(detail.ref_abp_code) ?? detail.ref_abp_code;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBin(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
}

function normalizeApiDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : value;
}

export type { AbpRefItem };
