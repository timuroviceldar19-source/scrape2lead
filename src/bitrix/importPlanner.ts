import type { FieldTransform, FieldValueSpec, ImportConfig } from "./importConfig.js";

export interface ImportRow {
  rowNumber: number;
  values: Record<string, string>;
}

export type ImportAction = "create" | "update" | "existing" | "duplicate" | "skip";

export interface DuplicateFilter {
  reason: string;
  filter: Record<string, string | number | boolean>;
}

const CRM_MULTI_FIELDS = new Set(["PHONE", "EMAIL", "WEB", "IM"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIN_LENGTH = 12;
const MIN_PHONE_DIGITS = 5;

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{([^{}]+)\}/g, (_, key: string) => (values[key.trim()] ?? "").trim())
    .trim();
}

export function applyTransform(value: string, transform: FieldTransform): string | number | null {
  switch (transform) {
    case "trim": {
      return value.trim() || null;
    }
    case "digits": {
      const digits = value.replace(/\D/g, "");
      return digits || null;
    }
    case "money": {
      const normalized = value.replace(/\s+/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
      const parsed = Number(normalized);
      return Number.isFinite(parsed) && normalized !== "" ? parsed : null;
    }
    case "bin": {
      const digits = value.replace(/\D/g, "");
      return digits.length === BIN_LENGTH ? digits : null;
    }
    case "email": {
      const first = value.split(/[;,]/)[0]?.trim() ?? "";
      return EMAIL_PATTERN.test(first) ? first : null;
    }
    case "phone": {
      const normalized = value.trim().replace(/[^\d+]/g, "");
      const digits = normalized.replace(/\D/g, "");
      return digits.length >= MIN_PHONE_DIGITS ? normalized : null;
    }
    case "url": {
      try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? value.trim() : null;
      } catch {
        return null;
      }
    }
  }
}

export function resolveFieldValue(
  spec: FieldValueSpec,
  values: Record<string, string>
): string | number | boolean | null {
  if (spec.value !== undefined) return spec.value;
  const raw = spec.template !== undefined
    ? renderTemplate(spec.template, values)
    : (values[spec.column ?? ""] ?? "").trim();
  if (!raw) return null;
  return spec.transform ? applyTransform(raw, spec.transform) : raw;
}

export function buildEntityFields(
  specs: Record<string, FieldValueSpec>,
  values: Record<string, string>
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = resolveFieldValue(spec, values);
    if (value === null || value === "") continue;
    fields[name] = CRM_MULTI_FIELDS.has(name)
      ? [{ VALUE: String(value), VALUE_TYPE: "WORK" }]
      : value;
  }
  return fields;
}

export function buildOriginId(config: Pick<ImportConfig, "originIdTemplate">, row: ImportRow): string {
  return renderTemplate(config.originIdTemplate, row.values);
}

export function validateRequired(config: Pick<ImportConfig, "required">, row: ImportRow): string[] {
  return config.required
    .filter((key) => !(row.values[key] ?? "").trim())
    .map((key) => `missing required column "${key}"`);
}

export function resolveDuplicateFilters(
  config: Pick<ImportConfig, "duplicateChecks">,
  row: ImportRow
): DuplicateFilter[] {
  const filters: DuplicateFilter[] = [];
  for (const check of config.duplicateChecks) {
    const filter: Record<string, string | number | boolean> = {};
    let complete = true;
    for (const [field, spec] of Object.entries(check.filter)) {
      const value = resolveFieldValue(spec, row.values);
      if (value === null || value === "") {
        complete = false;
        break;
      }
      filter[field] = value;
    }
    if (complete && Object.keys(filter).length > 0) {
      filters.push({ reason: check.reason, filter });
    }
  }
  return filters;
}

export function decideAction(input: {
  issueCount: number;
  existingId: string | null;
  duplicateId: string | null;
  updateExisting: boolean;
}): ImportAction {
  if (input.issueCount > 0) return "skip";
  if (input.existingId) return input.updateExisting ? "update" : "existing";
  if (input.duplicateId) return "duplicate";
  return "create";
}
