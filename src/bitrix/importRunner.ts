import type { BitrixEntity } from "./client.js";
import type { ImportConfig } from "./importConfig.js";
import {
  buildEntityFields,
  buildOriginId,
  decideAction,
  renderTemplate,
  resolveDuplicateFilters,
  validateRequired,
  type ImportAction,
  type ImportRow
} from "./importPlanner.js";

/** Structural subset of BitrixClient so tests can stub the CRM gateway. */
export interface BitrixCrmGateway {
  findFirst(
    entity: BitrixEntity,
    filter: Record<string, unknown>,
    select?: string[]
  ): Promise<Record<string, unknown> | null>;
  findByOrigin(
    entity: BitrixEntity,
    originatorId: string,
    originId: string
  ): Promise<Record<string, unknown> | null>;
  add(entity: BitrixEntity, fields: Record<string, unknown>): Promise<string>;
  update(entity: BitrixEntity, id: string, fields: Record<string, unknown>): Promise<void>;
}

export interface ImportPlanItem {
  row: ImportRow;
  originId: string;
  action: ImportAction;
  existingId: string | null;
  duplicateId: string | null;
  duplicateReason: string | null;
  issues: string[];
}

export interface ImportRunOptions {
  execute: boolean;
  updateExisting: boolean;
  limit?: number | null;
  log?: (line: string) => void;
}

export type ImportCounts = Record<ImportAction, number> & { failed: number };

export interface ImportRunResult {
  plan: ImportPlanItem[];
  counts: ImportCounts;
}

export async function planImport(
  client: BitrixCrmGateway,
  config: ImportConfig,
  rows: ImportRow[],
  updateExisting: boolean
): Promise<ImportPlanItem[]> {
  const plan: ImportPlanItem[] = [];

  for (const row of rows) {
    const originId = buildOriginId(config, row);
    const issues = validateRequired(config, row);
    if (!originId) issues.push("empty origin id");

    const existing = issues.length > 0
      ? null
      : await client.findByOrigin(config.entity, config.originatorId, originId);
    const existingId = existing?.ID != null ? String(existing.ID) : null;

    const duplicate = issues.length > 0 || existingId
      ? null
      : await findDuplicate(client, config, row, originId);

    plan.push({
      row,
      originId,
      existingId,
      duplicateId: duplicate?.id ?? null,
      duplicateReason: duplicate?.reason ?? null,
      issues,
      action: decideAction({
        issueCount: issues.length,
        existingId,
        duplicateId: duplicate?.id ?? null,
        updateExisting
      })
    });
  }

  return plan;
}

async function findDuplicate(
  client: BitrixCrmGateway,
  config: ImportConfig,
  row: ImportRow,
  originId: string
): Promise<{ id: string; reason: string } | null> {
  for (const { reason, filter } of resolveDuplicateFilters(config, row)) {
    const hit = await client.findFirst(config.entity, filter, ["ID", "ORIGINATOR_ID", "ORIGIN_ID"]);
    if (!hit?.ID) continue;
    const isSelf = String(hit.ORIGINATOR_ID ?? "") === config.originatorId
      && String(hit.ORIGIN_ID ?? "") === originId;
    if (isSelf) continue;
    return { id: String(hit.ID), reason };
  }
  return null;
}

export async function runImport(
  client: BitrixCrmGateway,
  config: ImportConfig,
  rows: ImportRow[],
  options: ImportRunOptions
): Promise<ImportRunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const limited = options.limit != null && options.limit > 0 ? rows.slice(0, options.limit) : rows;
  const plan = await planImport(client, config, limited, options.updateExisting);
  const counts: ImportCounts = { create: 0, update: 0, existing: 0, duplicate: 0, skip: 0, failed: 0 };

  for (const item of plan) {
    counts[item.action] += 1;

    if (item.action === "skip") {
      log(`[skip] row ${item.row.rowNumber} ${item.originId || "-"}: ${item.issues.join("; ")}`);
      continue;
    }
    if (item.action === "existing") {
      log(`[existing] row ${item.row.rowNumber} ${item.originId} -> ${config.entity} ${item.existingId}`);
      continue;
    }
    if (item.action === "duplicate") {
      log(`[duplicate] row ${item.row.rowNumber} ${item.originId} -> ${config.entity} ${item.duplicateId} (${item.duplicateReason})`);
      continue;
    }
    if (!options.execute) {
      log(`[dry-run] ${item.action} row ${item.row.rowNumber} ${item.originId}`);
      continue;
    }

    try {
      if (item.action === "update") {
        if (!item.existingId) throw new Error("existing entity id is missing");
        await client.update(config.entity, item.existingId, buildEntityFields(config.fields, item.row.values));
        log(`[updated] row ${item.row.rowNumber} ${item.originId} -> ${config.entity} ${item.existingId}`);
        continue;
      }

      const companyId = config.company ? await ensureCompany(client, config, item.row) : null;
      const entityId = await client.add(config.entity, buildCreateFields(config, item, companyId));
      log(`[created] row ${item.row.rowNumber} ${item.originId} -> ${config.entity} ${entityId}${companyId ? ` company ${companyId}` : ""}`);
    } catch (error) {
      counts[item.action] -= 1;
      counts.failed += 1;
      log(`[failed] row ${item.row.rowNumber} ${item.originId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { plan, counts };
}

function buildCreateFields(
  config: ImportConfig,
  item: ImportPlanItem,
  companyId: string | null
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    ...buildEntityFields(config.fields, item.row.values),
    ORIGINATOR_ID: config.originatorId,
    ORIGIN_ID: item.originId
  };
  if (config.defaults.assignedById !== undefined) fields.ASSIGNED_BY_ID = config.defaults.assignedById;
  if (config.defaults.sourceId !== undefined && fields.SOURCE_ID === undefined) {
    fields.SOURCE_ID = config.defaults.sourceId;
  }
  if (config.entity === "deal") {
    fields.CATEGORY_ID = config.defaults.categoryId ?? 0;
    if (config.defaults.stageId !== undefined) fields.STAGE_ID = config.defaults.stageId;
  }
  if (config.entity === "lead" && config.defaults.statusId !== undefined) {
    fields.STATUS_ID = config.defaults.statusId;
  }
  if (companyId) fields.COMPANY_ID = companyId;
  return fields;
}

async function ensureCompany(
  client: BitrixCrmGateway,
  config: ImportConfig,
  row: ImportRow
): Promise<string | null> {
  const link = config.company;
  if (!link) return null;

  const searchValue = (row.values[link.searchColumn] ?? "").trim();
  if (!searchValue) return null;

  const bySearchField = await client.findFirst("company", { [link.searchField]: searchValue });
  if (bySearchField?.ID != null) return String(bySearchField.ID);

  const companyOriginId = link.originIdTemplate ? renderTemplate(link.originIdTemplate, row.values) : "";
  if (companyOriginId) {
    const byOrigin = await client.findByOrigin("company", config.originatorId, companyOriginId);
    if (byOrigin?.ID != null) return String(byOrigin.ID);
  }

  const fields: Record<string, unknown> = {
    TITLE: searchValue,
    ...buildEntityFields(link.fields, row.values),
    [link.searchField]: searchValue
  };
  if (companyOriginId) {
    fields.ORIGINATOR_ID = config.originatorId;
    fields.ORIGIN_ID = companyOriginId;
  }
  if (config.defaults.assignedById !== undefined) fields.ASSIGNED_BY_ID = config.defaults.assignedById;

  return client.add("company", fields);
}
