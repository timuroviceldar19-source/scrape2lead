import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BitrixClient } from "../client.js";
import { renderDashboardHtml } from "./dashboard.js";
import { buildNormalizedReport, computeReportMetrics, mapCanonicalPhase } from "./model.js";
import { READ_ONLY_METHODS, ReadOnlyBitrixClient } from "./readOnlyClient.js";
import type {
  DashboardPayload,
  DataQuality,
  RawDeal,
  RawStageHistory,
  ReportingConfig,
  SnapshotManifest,
  StageMappingRow
} from "./types.js";

interface FileConfig extends Omit<ReportingConfig, "asOf"> {
  ageBuckets: string[];
  referenceCounts: Record<string, number>;
}

type AnyRow = Record<string, unknown>;

function arrayFrom(value: unknown, nestedKey?: string): AnyRow[] {
  if (Array.isArray(value)) return value as AnyRow[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (nestedKey && Array.isArray(record[nestedKey])) return record[nestedKey] as AnyRow[];
    for (const key of ["items", "categories", "result"]) if (Array.isArray(record[key])) return record[key] as AnyRow[];
  }
  return [];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function coverage(deals: RawDeal[], predicate: (deal: RawDeal) => boolean): number {
  return deals.length ? deals.filter(predicate).length / deals.length : 0;
}

function safePortalBase(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  return url.origin;
}

function stageEntity(categoryId: number): string {
  return categoryId === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${categoryId}`;
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text, "utf8");
  return text;
}

export interface GenerateReportOptions {
  webhookUrl: string;
  asOfDate: string;
  outputDir: string;
  configPath?: string;
}

export async function generateBitrixReport(options: GenerateReportOptions): Promise<SnapshotManifest> {
  const configPath = resolve(options.configPath ?? "config/bitrix-b2g-report.json");
  const fileConfig = JSON.parse(await readFile(configPath, "utf8")) as FileConfig;
  const offset = "+03:00";
  const config: ReportingConfig = { ...fileConfig, asOf: `${options.asOfDate}T23:59:59${offset}` };
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const transport = new BitrixClient(options.webhookUrl, { requestDelayMs: 550, maxRetries: 5 });
  const client = new ReadOnlyBitrixClient(transport);

  const categoryRaw = await client.call("crm.category.list", { entityTypeId: 2 });
  const fieldsRaw = await client.call("crm.deal.fields");
  // This legacy method returns the complete metadata array and ignores `start`.
  const userFields = arrayFrom(await client.call("crm.deal.userfield.list", { order: { ID: "ASC" } }))
    .map((row) => ({
      ID: row.ID, FIELD_NAME: row.FIELD_NAME, USER_TYPE_ID: row.USER_TYPE_ID,
      EDIT_FORM_LABEL: row.EDIT_FORM_LABEL, LIST_COLUMN_LABEL: row.LIST_COLUMN_LABEL,
      XML_ID: row.XML_ID, MULTIPLE: row.MULTIPLE, MANDATORY: row.MANDATORY
    }));
  const categoriesDeals = await client.listAllBatched<AnyRow>("crm.deal.list", {
      order: { ID: "ASC" },
      select: ["ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "OPPORTUNITY", "CURRENCY_ID", "DATE_CREATE", "DATE_MODIFY", "ASSIGNED_BY_ID", "COMPANY_ID", "SOURCE_ID"]
    });
  const history = await client.listAllBatched<AnyRow>("crm.stagehistory.list", {
      entityTypeId: 2, order: { ID: "ASC" },
      select: ["ID", "TYPE_ID", "OWNER_ID", "CREATED_TIME", "CATEGORY_ID", "STAGE_SEMANTIC_ID", "STAGE_ID"]
    }, "items");
  const companies = await client.listAllBatched<AnyRow>("crm.company.list", { order: { ID: "ASC" }, select: ["ID", "TITLE"] });

  const categories = arrayFrom(categoryRaw, "categories");
  const pipelineNames = Object.fromEntries(categories.map((row) => [String(row.id ?? row.ID), String(row.name ?? row.NAME ?? row.title ?? row.TITLE)]));
  const statusResponses: unknown[] = [];
  for (const row of categories) {
    statusResponses.push(await client.call("crm.status.list", {
      filter: { ENTITY_ID: stageEntity(Number(row.id ?? row.ID)) }, order: { SORT: "ASC" }
    }));
  }
  const statuses = statusResponses.flatMap((value) => arrayFrom(value));
  const stageNames = Object.fromEntries(statuses.map((row) => [String(row.STATUS_ID), String(row.NAME)]));
  // The configured webhook has CRM scope only. Stable assignee IDs are retained;
  // no broader user profiles (and therefore no user emails/phones) are fetched.
  const managerNames: Record<string, string> = {};
  const companyNames = Object.fromEntries(companies.map((row) => [String(row.ID), String(row.TITLE ?? "")])) as Record<string, string>;
  const deals = categoriesDeals as unknown as RawDeal[];
  const stageHistory = history as unknown as RawStageHistory[];
  const portalBaseUrl = safePortalBase(options.webhookUrl);
  const normalized = buildNormalizedReport(deals, stageHistory, config, { pipelineNames, stageNames, managerNames, companyNames, portalBaseUrl });
  const metrics = computeReportMetrics(normalized, config);

  const currentStageIds = new Set(statuses.map((row) => String(row.STATUS_ID)));
  const retiredStageIds = new Set(stageHistory.map((row) => String(row.STAGE_ID ?? "")).filter((id) => id && !currentStageIds.has(id)));
  const unknownEvents = stageHistory.filter((row) =>
    config.selectedPipelineIds.includes(Number(row.CATEGORY_ID))
    && mapCanonicalPhase(Number(row.CATEGORY_ID), String(row.STAGE_ID ?? ""), String(row.STAGE_SEMANTIC_ID ?? "")) === "legacy_unknown"
  );
  const stageMapping: StageMappingRow[] = statuses.map((row) => {
    const rawStageId = String(row.STATUS_ID);
    const pipelineId = Number(String(row.ENTITY_ID ?? "DEAL_STAGE").replace("DEAL_STAGE_", "")) || 0;
    const canonicalPhase = mapCanonicalPhase(pipelineId, rawStageId, String(row.SEMANTICS ?? ""));
    return { pipelineId, rawStageId, rawStageName: String(row.NAME ?? rawStageId), canonicalPhase, confidence: canonicalPhase === "legacy_unknown" ? "unknown" : "exact" };
  });
  for (const rawStageId of retiredStageIds) {
    const sample = stageHistory.find((row) => row.STAGE_ID === rawStageId)!;
    const pipelineId = Number(sample.CATEGORY_ID);
    const canonicalPhase = mapCanonicalPhase(pipelineId, rawStageId, String(sample.STAGE_SEMANTIC_ID ?? ""));
    stageMapping.push({ pipelineId, rawStageId, rawStageName: "Удалённая стадия", canonicalPhase, confidence: canonicalPhase === "legacy_unknown" ? "unknown" : "legacy_exact" });
  }
  const selectedRaw = deals.filter((deal) => config.selectedPipelineIds.includes(Number(deal.CATEGORY_ID)));
  const dataQuality: DataQuality = {
    amountCoverageRate: coverage(selectedRaw, (deal) => Number(deal.OPPORTUNITY) > 0),
    companyCoverageRate: coverage(selectedRaw, (deal) => Boolean(deal.COMPANY_ID && String(deal.COMPANY_ID) !== "0")),
    sourceCoverageRate: coverage(selectedRaw, (deal) => Boolean(deal.SOURCE_ID)),
    assignedCoverageRate: coverage(selectedRaw, (deal) => Boolean(deal.ASSIGNED_BY_ID && String(deal.ASSIGNED_BY_ID) !== "0")),
    unknownStageEvents: unknownEvents.length,
    retiredStageKeys: retiredStageIds.size,
    notes: [
      "Денежные KPI включают только положительную OPPORTUNITY и всегда сопровождаются покрытием.",
      "Воронка 29 — очередь маршрутизации; её технические WON/LOSE не входят в конверсию.",
      "TYPE_ID=5 — перенос между воронками, а не повторный вход или исход.",
      `${retiredStageIds.size} удалённых кодов стадий сохранены как исторический контекст; неоднозначные отмечены legacy_unknown.`,
      "Webhook не имеет scope user: ответственные показаны стабильными ID без выгрузки профилей, email и телефонов."
    ]
  };
  const payload: DashboardPayload = {
    generatedAt: new Date().toISOString(), asOfDate: options.asOfDate, portalBaseUrl,
    metrics, deals: normalized.deals, pipelineNames, managerNames, stageMapping, dataQuality
  };

  const dashboard = renderDashboardHtml(payload);
  const metricsText = await writeJson(join(outputDir, "report-metrics.json"), metrics);
  const mappingText = await writeJson(join(outputDir, "stage-mapping.json"), stageMapping);
  const userFieldText = await writeJson(join(outputDir, "deal-user-fields-metadata.json"), userFields);
  const audit = {
    generatedAt: payload.generatedAt,
    referenceCounts: fileConfig.referenceCounts,
    observedCounts: { deals: deals.length, pipelines: categories.length, stageHistory: stageHistory.length, customFields: userFields.length || Object.keys((fieldsRaw ?? {}) as object).filter((key) => key.startsWith("UF_")).length },
    matchesReference: Object.fromEntries(Object.entries(fileConfig.referenceCounts).map(([key, value]) => [key, value === ({ deals: deals.length, pipelines: categories.length, stageHistory: stageHistory.length } as Record<string, number>)[key]])),
    dataQuality,
    exclusions: { routing: metrics.routingDeals, serviceHandoffs: normalized.deals.filter((deal) => deal.outcome === "handoff_service").length, unknownOutcomes: normalized.deals.filter((deal) => deal.outcome === "unknown").length },
    privacy: { contactsFetched: false, phonesFetched: false, emailsFetched: false, dashboardContainsOperationalNames: true, slidesContainOperationalNames: false }
  };
  const auditText = await writeJson(join(outputDir, "data-audit.json"), audit);
  await writeFile(join(outputDir, "dashboard.html"), dashboard, "utf8");
  const manifest: SnapshotManifest = {
    snapshotAt: payload.generatedAt, asOfDate: options.asOfDate, timeZoneOffset: offset,
    sourceCounts: { deals: deals.length, pipelines: categories.length, currentStages: statuses.length, stageHistory: stageHistory.length, companies: companies.length, userProfiles: 0 },
    normalizedCounts: { deals: normalized.deals.length, migrations: normalized.migrations.length, salesDeals: metrics.salesDeals, routingDeals: metrics.routingDeals },
    sha256: { "dashboard.html": sha256(dashboard), "report-metrics.json": sha256(metricsText), "stage-mapping.json": sha256(mappingText), "deal-user-fields-metadata.json": sha256(userFieldText), "data-audit.json": sha256(auditText) },
    readOnlyMethods: [...READ_ONLY_METHODS]
  };
  await writeJson(join(outputDir, "snapshot-manifest.json"), manifest);
  return manifest;
}
