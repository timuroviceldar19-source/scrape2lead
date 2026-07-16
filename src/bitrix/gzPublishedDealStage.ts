import type { GzRoutingConfig } from "./gzDealRouting.js";

export const GZ_PUBLISHED_AT_FIELD = "UF_CRM_S2L_GZ_PUBLISHED_AT";
export const GZ_PLAN_STATUS_FIELD = "UF_CRM_PLAN_STATUS";
export const GZ_PLAN_STATUS_LEGACY_FIELD = "UF_CRM_6627AEBD85B4D";
export const GZ_PUBLISHED_STAGE_NAME = "Опубликован";

export interface PublishedStageRoute {
  categoryId: number;
  initialStageId: string;
  publishedStageId: string;
}

export interface PublishedDealSnapshot {
  CATEGORY_ID?: string | number | null;
  STAGE_ID?: string | null;
  UF_CRM_PLAN_STATUS?: string | null;
  UF_CRM_6627AEBD85B4D?: string | null;
  UF_CRM_S2L_GZ_PUBLISHED_AT?: string | null;
}

export type PublishedStageAction = "moved" | "already-published" | "skipped-noninitial";

export interface PublishedDealUpdate {
  fields: Record<string, string>;
  stageAction: PublishedStageAction;
  stageSkipReason: string | null;
}

export interface PublishedDealUpdateClient {
  updateDeal(id: string, fields: Record<string, string>): Promise<void>;
}

export interface BitrixDealStage {
  ENTITY_ID?: string | null;
  STATUS_ID?: string | null;
  NAME?: string | null;
  SORT?: string | number | null;
  SEMANTICS?: string | null;
}

export interface AddPublishedStageInput {
  categoryId: number;
  statusId: string;
  name: string;
  sort: number;
  semantics: "";
}

export interface PublishedStageClient {
  listDealStages(categoryId: number): Promise<BitrixDealStage[]>;
  addDealStage(input: AddPublishedStageInput): Promise<void>;
}

export interface PublishedStageSetupResult {
  categoryId: number;
  publishedStageId: string;
  action: "planned" | "created" | "present";
}

export function listPublishedStageRoutes(config: GzRoutingConfig): PublishedStageRoute[] {
  const routes = [...config.rules, config.default];
  const result = new Map<number, PublishedStageRoute>();
  for (const route of routes) {
    result.set(route.categoryId, {
      categoryId: route.categoryId,
      initialStageId: route.stageId,
      publishedStageId: route.publishedStageId
    });
  }
  return [...result.values()];
}

export function buildPublishedDealUpdate(
  deal: PublishedDealSnapshot,
  route: PublishedStageRoute,
  detectedStatus: string,
  detectedAt: string
): PublishedDealUpdate {
  const fields: Record<string, string> = {};
  const currentStageId = text(deal.STAGE_ID);
  let stageAction: PublishedStageAction;
  let stageSkipReason: string | null = null;

  if (currentStageId === route.initialStageId) {
    fields.STAGE_ID = route.publishedStageId;
    stageAction = "moved";
  } else if (currentStageId === route.publishedStageId) {
    stageAction = "already-published";
  } else {
    stageAction = "skipped-noninitial";
    stageSkipReason = `current stage ${currentStageId || "-"} is not initial ${route.initialStageId}`;
  }

  if (text(deal.UF_CRM_PLAN_STATUS) !== detectedStatus) fields[GZ_PLAN_STATUS_FIELD] = detectedStatus;
  if (text(deal.UF_CRM_6627AEBD85B4D) !== detectedStatus) fields[GZ_PLAN_STATUS_LEGACY_FIELD] = detectedStatus;
  if (!text(deal.UF_CRM_S2L_GZ_PUBLISHED_AT)) fields[GZ_PUBLISHED_AT_FIELD] = detectedAt;

  return { fields, stageAction, stageSkipReason };
}

export async function applyPublishedDealUpdate(
  client: PublishedDealUpdateClient,
  dealId: string,
  update: PublishedDealUpdate,
  execute: boolean
): Promise<boolean> {
  if (!execute || Object.keys(update.fields).length === 0) return false;
  await client.updateDeal(dealId, update.fields);
  return true;
}

export async function ensurePublishedDealStages(
  client: PublishedStageClient,
  routes: PublishedStageRoute[],
  execute: boolean
): Promise<PublishedStageSetupResult[]> {
  const snapshots = await Promise.all(routes.map(async (route) => ({
    route,
    stages: await client.listDealStages(route.categoryId)
  })));

  // Validate every existing target before creating anything, so conflicts cannot
  // leave a partially provisioned set of funnels.
  for (const snapshot of snapshots) {
    const existing = findStage(snapshot.stages, snapshot.route.publishedStageId);
    if (existing) validatePublishedStage(existing, snapshot.route);
    if (!findStage(snapshot.stages, snapshot.route.initialStageId)) {
      throw new Error(`initial stage ${snapshot.route.initialStageId} is missing in category ${snapshot.route.categoryId}`);
    }
  }

  const actions = new Map<number, PublishedStageSetupResult["action"]>();
  for (const snapshot of snapshots) {
    if (findStage(snapshot.stages, snapshot.route.publishedStageId)) {
      actions.set(snapshot.route.categoryId, "present");
      continue;
    }
    if (!execute) {
      actions.set(snapshot.route.categoryId, "planned");
      continue;
    }
    const initial = findStage(snapshot.stages, snapshot.route.initialStageId)!;
    await client.addDealStage({
      categoryId: snapshot.route.categoryId,
      statusId: snapshot.route.publishedStageId,
      name: GZ_PUBLISHED_STAGE_NAME,
      sort: numericSort(initial.SORT) + 1,
      semantics: ""
    });
    actions.set(snapshot.route.categoryId, "created");
  }

  if (execute) {
    for (const route of routes) {
      const stages = await client.listDealStages(route.categoryId);
      const created = findStage(stages, route.publishedStageId);
      if (!created) throw new Error(`published stage ${route.publishedStageId} was not found after setup`);
      validatePublishedStage(created, route);
    }
  }

  return routes.map((route) => ({
    categoryId: route.categoryId,
    publishedStageId: route.publishedStageId,
    action: actions.get(route.categoryId) ?? "present"
  }));
}

export async function validatePublishedDealStages(
  client: PublishedStageClient,
  routes: PublishedStageRoute[]
): Promise<void> {
  const result = await ensurePublishedDealStages(client, routes, false);
  const missing = result.filter((item) => item.action === "planned");
  if (missing.length > 0) {
    throw new Error(`published stages are missing: ${missing.map((item) => item.publishedStageId).join(", ")}; run --ensure-published-stages --execute first`);
  }
}

function validatePublishedStage(stage: BitrixDealStage, route: PublishedStageRoute): void {
  const expectedEntity = `DEAL_STAGE_${route.categoryId}`;
  const entity = text(stage.ENTITY_ID);
  const name = text(stage.NAME);
  const semantics = text(stage.SEMANTICS);
  if ((entity && entity !== expectedEntity) || name !== GZ_PUBLISHED_STAGE_NAME || semantics === "S" || semantics === "F") {
    throw new Error(`published stage ${route.publishedStageId} conflicts with expected active stage "${GZ_PUBLISHED_STAGE_NAME}" in ${expectedEntity}`);
  }
}

function findStage(stages: BitrixDealStage[], statusId: string): BitrixDealStage | undefined {
  return stages.find((stage) => text(stage.STATUS_ID) === statusId);
}

function numericSort(value: string | number | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 10;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}
