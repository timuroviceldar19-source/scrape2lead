const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEAL_OWNER_TYPE_ID = 2;

export interface RawActivity {
  ID: string;
  OWNER_ID: string | number;
  OWNER_TYPE_ID: string | number;
  CREATED: string;
  COMPLETED?: string;
  RESPONSIBLE_ID?: string | number;
  TYPE_ID?: string | number;
  DEADLINE?: string;
}

export interface ActivityDealInput {
  id: string;
  pipelineId: number;
  createdAt: string;
  isOpen: boolean;
  managerId: string;
}

export interface ActivityMetricsConfig {
  asOf: string;
  staleAfterDays: number;
}

export interface ActivityMetrics {
  dealsAnalyzed: { open: number; closed: number };
  dealsWithoutActivity: { open: number; closed: number };
  firstReactionHours: { median: number | null; p90: number | null; sampleSize: number };
  abandonedOpenDeals: { noPlannedNextStep: number; noActivityForDays: number; staleAfterDays: number };
  byPipeline: Array<{ pipelineId: number; deals: number; dealsWithoutActivity: number; avgActivities: number }>;
  byManager: Array<{ managerId: string; openDeals: number; openWithoutActivity: number; abandonedOpen: number }>;
}

interface DealActivitySummary {
  count: number;
  firstCreatedMs: number | null;
  lastCreatedMs: number | null;
  pendingCount: number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarizeActivities(deals: ActivityDealInput[], activities: RawActivity[]): Map<string, DealActivitySummary> {
  const known = new Set(deals.map((item) => item.id));
  const summaries = new Map<string, DealActivitySummary>();
  for (const item of activities) {
    if (Number(item.OWNER_TYPE_ID) !== DEAL_OWNER_TYPE_ID) continue;
    const dealId = String(item.OWNER_ID);
    if (!known.has(dealId)) continue;
    const createdMs = Date.parse(item.CREATED);
    const previous = summaries.get(dealId) ?? { count: 0, firstCreatedMs: null, lastCreatedMs: null, pendingCount: 0 };
    summaries.set(dealId, {
      count: previous.count + 1,
      firstCreatedMs: previous.firstCreatedMs === null ? createdMs : Math.min(previous.firstCreatedMs, createdMs),
      lastCreatedMs: previous.lastCreatedMs === null ? createdMs : Math.max(previous.lastCreatedMs, createdMs),
      pendingCount: previous.pendingCount + (item.COMPLETED === "N" ? 1 : 0)
    });
  }
  return summaries;
}

export function computeActivityMetrics(
  deals: ActivityDealInput[],
  activities: RawActivity[],
  config: ActivityMetricsConfig
): ActivityMetrics {
  const asOfMs = Date.parse(config.asOf);
  const staleBeforeMs = asOfMs - config.staleAfterDays * DAY_MS;
  const summaries = summarizeActivities(deals, activities);

  const dealsAnalyzed = { open: 0, closed: 0 };
  const dealsWithoutActivity = { open: 0, closed: 0 };
  const reactionHours: number[] = [];
  const abandoned = { noPlannedNextStep: 0, noActivityForDays: 0, staleAfterDays: config.staleAfterDays };
  const byPipeline = new Map<number, { deals: number; dealsWithoutActivity: number; totalActivities: number }>();
  const byManager = new Map<string, { openDeals: number; openWithoutActivity: number; abandonedOpen: number }>();

  for (const item of deals) {
    const summary = summaries.get(item.id);
    const bucket = item.isOpen ? "open" : "closed";
    dealsAnalyzed[bucket] += 1;
    if (!summary) dealsWithoutActivity[bucket] += 1;

    const pipeline = byPipeline.get(item.pipelineId) ?? { deals: 0, dealsWithoutActivity: 0, totalActivities: 0 };
    byPipeline.set(item.pipelineId, {
      deals: pipeline.deals + 1,
      dealsWithoutActivity: pipeline.dealsWithoutActivity + (summary ? 0 : 1),
      totalActivities: pipeline.totalActivities + (summary?.count ?? 0)
    });

    if (summary?.firstCreatedMs !== null && summary?.firstCreatedMs !== undefined) {
      const deltaMs = Math.max(0, summary.firstCreatedMs - Date.parse(item.createdAt));
      reactionHours.push(round(deltaMs / HOUR_MS));
    }

    if (!item.isOpen) continue;

    const hasNextStep = (summary?.pendingCount ?? 0) > 0;
    const lastTouchMs = summary?.lastCreatedMs ?? Date.parse(item.createdAt);
    const isStale = lastTouchMs < staleBeforeMs;
    if (!hasNextStep) abandoned.noPlannedNextStep += 1;
    if (!hasNextStep && isStale) abandoned.noActivityForDays += 1;

    const manager = byManager.get(item.managerId) ?? { openDeals: 0, openWithoutActivity: 0, abandonedOpen: 0 };
    byManager.set(item.managerId, {
      openDeals: manager.openDeals + 1,
      openWithoutActivity: manager.openWithoutActivity + (summary ? 0 : 1),
      abandonedOpen: manager.abandonedOpen + (!hasNextStep && isStale ? 1 : 0)
    });
  }

  const sortedReactions = [...reactionHours].sort((left, right) => left - right);

  return {
    dealsAnalyzed,
    dealsWithoutActivity,
    firstReactionHours: sortedReactions.length
      ? {
          median: median(sortedReactions),
          p90: percentile(sortedReactions, 0.9),
          sampleSize: sortedReactions.length
        }
      : { median: null, p90: null, sampleSize: 0 },
    abandonedOpenDeals: abandoned,
    byPipeline: [...byPipeline.entries()]
      .map(([pipelineId, row]) => ({
        pipelineId,
        deals: row.deals,
        dealsWithoutActivity: row.dealsWithoutActivity,
        avgActivities: row.deals ? round(row.totalActivities / row.deals) : 0
      }))
      .sort((left, right) => left.pipelineId - right.pipelineId),
    byManager: [...byManager.entries()]
      .map(([managerId, row]) => ({ managerId, ...row }))
      .sort((left, right) => right.openDeals - left.openDeals)
  };
}
