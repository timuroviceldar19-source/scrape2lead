import fs from "node:fs";
import { z } from "zod";

const transformSchema = z.enum(["trim", "digits", "money", "bin", "email", "phone", "url"]);

const fieldValueSchema = z.object({
  column: z.string().min(1).optional(),
  template: z.string().min(1).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  transform: transformSchema.optional()
}).refine(
  (spec) => [spec.column, spec.template, spec.value].filter((part) => part !== undefined).length === 1,
  { message: "field spec needs exactly one of: column, template, value" }
).refine(
  (spec) => spec.transform === undefined || spec.value === undefined,
  { message: "transform cannot be combined with a constant value" }
);

const columnSchema = z.object({
  key: z.string().min(1),
  header: z.string().min(1).optional(),
  index: z.number().int().positive().optional()
}).refine(
  (column) => (column.header !== undefined) !== (column.index !== undefined),
  { message: "column needs exactly one of: header, index" }
);

const duplicateCheckSchema = z.object({
  reason: z.string().min(1),
  filter: z.record(fieldValueSchema)
});

const companyLinkSchema = z.object({
  searchField: z.string().min(1),
  searchColumn: z.string().min(1),
  originIdTemplate: z.string().min(1).optional(),
  fields: z.record(fieldValueSchema).default({})
});

export const importConfigSchema = z.object({
  entity: z.enum(["lead", "deal"]),
  originatorId: z.string().min(1),
  originIdTemplate: z.string().min(1),
  sheet: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  headerRow: z.number().int().positive().default(1),
  columns: z.array(columnSchema).min(1),
  required: z.array(z.string().min(1)).default([]),
  fields: z.record(fieldValueSchema),
  duplicateChecks: z.array(duplicateCheckSchema).default([]),
  defaults: z.object({
    assignedById: z.number().int().positive().optional(),
    categoryId: z.number().int().nonnegative().optional(),
    stageId: z.string().min(1).optional(),
    statusId: z.string().min(1).optional(),
    sourceId: z.string().min(1).optional()
  }).default({}),
  company: companyLinkSchema.optional()
});

export type ImportConfig = z.infer<typeof importConfigSchema>;
export type FieldValueSpec = z.infer<typeof fieldValueSchema>;
export type FieldTransform = z.infer<typeof transformSchema>;

const TEMPLATE_PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

export function extractTemplateKeys(template: string): string[] {
  return [...template.matchAll(TEMPLATE_PLACEHOLDER_PATTERN)].map((match) => match[1].trim());
}

function collectFieldSpecRefs(specs: Record<string, FieldValueSpec>): string[] {
  const refs: string[] = [];
  for (const spec of Object.values(specs)) {
    if (spec.column !== undefined) refs.push(spec.column);
    if (spec.template !== undefined) refs.push(...extractTemplateKeys(spec.template));
  }
  return refs;
}

function collectColumnRefs(config: ImportConfig): string[] {
  const refs: string[] = [
    ...extractTemplateKeys(config.originIdTemplate),
    ...config.required,
    ...collectFieldSpecRefs(config.fields)
  ];
  for (const check of config.duplicateChecks) {
    refs.push(...collectFieldSpecRefs(check.filter));
  }
  if (config.company) {
    refs.push(config.company.searchColumn);
    refs.push(...collectFieldSpecRefs(config.company.fields));
    if (config.company.originIdTemplate) {
      refs.push(...extractTemplateKeys(config.company.originIdTemplate));
    }
  }
  return refs;
}

export function parseImportConfig(data: unknown): ImportConfig {
  const config = importConfigSchema.parse(data);

  const columnKeys = new Set<string>();
  for (const column of config.columns) {
    if (columnKeys.has(column.key)) {
      throw new Error(`import config: duplicate column key "${column.key}"`);
    }
    columnKeys.add(column.key);
  }

  const unknownRefs = [...new Set(collectColumnRefs(config))].filter((ref) => !columnKeys.has(ref));
  if (unknownRefs.length > 0) {
    throw new Error(`import config: unknown column reference(s): ${unknownRefs.join(", ")}`);
  }

  return config;
}

export function loadImportConfig(filePath: string): ImportConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`import config: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`import config: invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parseImportConfig(data);
}
