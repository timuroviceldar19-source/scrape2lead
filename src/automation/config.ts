import fs from "node:fs";
import { z } from "zod";
import { hasBrokenEncoding } from "./core.js";
import type { AutomationConfig } from "./types.js";

const AutomationConfigSchema = z.object({
  workflow: z.enum(["plans-and-lots", "plans-only"]).default("plans-and-lots"),
  runsDir: z.string().min(1).default("runs"),
  keepSuccessfulRuns: z.number().int().positive().default(30),
  lockPath: z.string().min(1).default("runs/prepare.lock"),
  staleLockMinutes: z.number().int().positive().default(180),
  plansConfig: z.string().min(1).default("config/gz-plans.json"),
  lotsConfig: z.string().min(1).default("config/gz-lots-computers.json"),
  periodMonths: z.number().int().min(1).max(24).default(6),
  approvalLimit: z.number().int().positive().nullable().default(null)
});

export function loadAutomationConfig(filePath = "config/automation.json"): AutomationConfig {
  if (!fs.existsSync(filePath)) throw new Error(`automation config not found: ${filePath}`);
  const config = AutomationConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
  validateCollectorConfig(config.plansConfig, "plans");
  if (config.workflow === "plans-and-lots") validateCollectorConfig(config.lotsConfig, "lots");
  return { ...config, sourcePath: filePath };
}

export function validateCollectorConfig(filePath: string, name: string): void {
  if (!fs.existsSync(filePath)) throw new Error(`${name} config not found: ${filePath}`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { keywords?: unknown; statuses?: unknown; nstruCodes?: unknown };
  const values = [...stringArray(raw.keywords, `${name}.keywords`), ...stringArray(raw.statuses, `${name}.statuses`)];
  if (raw.nstruCodes !== undefined) values.push(...stringArray(raw.nstruCodes, `${name}.nstruCodes`));
  validateCollectorText(name, values);
}

export function validateCollectorText(name: string, values: string[]): void {
  if (values.some((value) => value.trim() === "")) throw new Error(`${name} config contains blank values`);
  if (hasBrokenEncoding(values)) throw new Error(`${name} config contains broken text encoding`);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
  return value as string[];
}
