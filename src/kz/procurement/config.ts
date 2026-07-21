import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  sources: z.array(z.enum(["mitwork", "samruk", "tizilim"])).min(1),
  keywords: z.array(z.string().trim().min(1)).min(1),
  minAmount: z.number().nonnegative(),
  pkTruPrefixes: z.array(z.string().trim().min(1)).min(1),
  panelKeywords: z.array(z.string().trim().min(1)).min(1),
  stopWords: z.array(z.string().trim().min(1)),
  pageSize: z.number().int().min(1).max(100).default(50),
  maxPages: z.number().int().min(1).default(5),
  delayMs: z.number().int().nonnegative().default(200),
  databasePath: z.string().min(1),
  outputDirectory: z.string().min(1),
  manualRunsRequired: z.number().int().min(1).default(7),
  bitrix: z.object({
    categoryId: z.literal(1),
    stageId: z.literal("C1:NEW"),
    managerIds: z.tuple([z.literal("2015"), z.literal("2209"), z.literal("2255")]),
    executeEnabled: z.boolean().default(false)
  })
});

export type ProcurementConfig = z.infer<typeof schema>;

export function loadProcurementConfig(configPath: string): ProcurementConfig {
  const resolved = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  return schema.parse(parsed);
}
