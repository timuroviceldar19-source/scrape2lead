import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GzPlanExportOptions } from "./goszakupPlanTypes.js";
import { DEFAULT_GZ_EXCLUDE_KEYWORDS } from "./gzItemFilter.js";
import {
  DEFAULT_GZ_PLAN_KEYWORDS,
  DEFAULT_GZ_PLAN_STATUSES,
  GZ_PLAN_STATUS_BY_NAME
} from "./goszakupPlanTypes.js";

export const DEFAULT_GZ_PLANS_CONFIG_PATH = "config/gz-plans.json";

const GzPlansConfigSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1).default([...DEFAULT_GZ_PLAN_KEYWORDS]),
  year: z.coerce.number().int().min(2000).max(2100).default(2026),
  months: z.array(z.coerce.number().int().min(1).max(12)).default([6, 7, 8]),
  statuses: z.array(z.string().min(1)).default([...DEFAULT_GZ_PLAN_STATUSES]),
  minAmount: z.coerce.number().nonnegative().default(0),
  excludeKeywords: z.array(z.string().min(1)).default([...DEFAULT_GZ_EXCLUDE_KEYWORDS]),
  maxPages: z.coerce.number().int().positive().default(50),
  delayMs: z.coerce.number().int().nonnegative().default(2000),
  skipRegistry: z.boolean().default(false),
  forceRegistryRefresh: z.boolean().default(false),
  headless: z.boolean().default(true),
  outPath: z.string().nullable().default(null),
  databasePath: z.string().default("data/scrape2lead.db"),
  debugDir: z.string().default("data/debug"),
  pageLoadTimeoutMs: z.coerce.number().int().positive().default(30_000),
  keepDuplicates: z.boolean().default(false)
});

export type GzPlansConfig = z.infer<typeof GzPlansConfigSchema>;

export type GzPlansFileConfig = Omit<GzPlansConfig, "outPath" | "databasePath" | "debugDir"> & {
  outPath: string | null;
  databasePath: string;
  debugDir: string;
};

export function loadGzPlansConfig(
  configPath: string = DEFAULT_GZ_PLANS_CONFIG_PATH,
  overrides: Partial<GzPlansConfig> = {}
): GzPlansFileConfig {
  const fileConfig = fs.existsSync(configPath)
    ? (JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>)
    : {};

  const parsed = GzPlansConfigSchema.parse({ ...fileConfig, ...overrides });

  return {
    ...parsed,
    outPath: parsed.outPath ? path.resolve(parsed.outPath) : null,
    databasePath: path.resolve(parsed.databasePath),
    debugDir: path.resolve(parsed.debugDir)
  };
}

export function mergeGzPlansExportOptions(
  fileConfig: GzPlansFileConfig,
  cliOverrides: Partial<GzPlansConfig> & {
    outPath?: string | null;
    configPath?: string;
  } = {}
): GzPlanExportOptions {
  const { configPath: _configPath, ...rest } = cliOverrides;
  const merged = GzPlansConfigSchema.parse({ ...fileConfig, ...rest });

  const maxPages = rest.maxPages ?? Number(process.env.GOSZAKUP_PLAN_MAX_PAGES ?? merged.maxPages);
  const delayMs = rest.delayMs ?? Number(process.env.KZ_ENRICH_DELAY_MS ?? merged.delayMs);

  const outPath = rest.outPath !== undefined
    ? (rest.outPath ? path.resolve(rest.outPath) : undefined)
    : (fileConfig.outPath ?? undefined);

  return {
    keywords: merged.keywords,
    year: merged.year,
    months: merged.months,
    statuses: merged.statuses,
    minAmount: merged.minAmount,
    excludeKeywords: merged.excludeKeywords,
    maxPages,
    delayMs,
    skipRegistry: merged.skipRegistry,
    forceRegistryRefresh: merged.forceRegistryRefresh,
    headless: merged.headless,
    outPath,
    databasePath: fileConfig.databasePath,
    debugDir: fileConfig.debugDir,
    pageLoadTimeoutMs: merged.pageLoadTimeoutMs,
    keepDuplicates: merged.keepDuplicates
  };
}

export function resolvePlanStatusIds(statuses: string[]): number[] {
  if (statuses.length === 0) return [];

  const ids: number[] = [];
  const unknown: string[] = [];

  for (const raw of statuses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^\d+$/.test(trimmed)) {
      ids.push(Number(trimmed));
      continue;
    }

    const id = lookupPlanStatusId(trimmed);
    if (id == null) {
      unknown.push(trimmed);
      continue;
    }
    ids.push(id);
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown plan status(es): ${unknown.join(", ")}. Known: ${Object.keys(GZ_PLAN_STATUS_BY_NAME).join(", ")}`
    );
  }

  return [...new Set(ids)];
}

export function resolvePlanStatusNames(statuses: string[]): string[] {
  if (statuses.length === 0) return [];

  const names: string[] = [];
  for (const raw of statuses) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (/^\d+$/.test(trimmed)) {
      const name = lookupPlanStatusName(Number(trimmed));
      if (name) names.push(name);
      continue;
    }

    const canonical = lookupPlanStatusCanonicalName(trimmed);
    if (canonical) names.push(canonical);
  }

  return [...new Set(names)];
}

function lookupPlanStatusId(name: string): number | null {
  const normalized = normalizePlanStatusLabel(name);
  for (const [label, id] of Object.entries(GZ_PLAN_STATUS_BY_NAME)) {
    if (normalizePlanStatusLabel(label) === normalized) {
      return id;
    }
  }
  return null;
}

function lookupPlanStatusName(id: number): string | null {
  for (const [label, value] of Object.entries(GZ_PLAN_STATUS_BY_NAME)) {
    if (value === id) return label;
  }
  return null;
}

function lookupPlanStatusCanonicalName(name: string): string | null {
  const normalized = normalizePlanStatusLabel(name);
  for (const label of Object.keys(GZ_PLAN_STATUS_BY_NAME)) {
    if (normalizePlanStatusLabel(label) === normalized) {
      return label;
    }
  }
  return null;
}

function normalizePlanStatusLabel(value: string): string {
  return value.trim().toLocaleLowerCase("ru");
}
