import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { pathToFileURL } from "node:url";

dotenv.config();

interface CliArgs {
  inputPath: string;
  execute: boolean;
  limit: number | null;
  delayMs: number;
  webhookUrl: string | null;
  assignedById: number | null;
  skipExistingCheck: boolean;
  planId: string | null;
  updateExisting: boolean;
  ensureFields: boolean;
  ensureLayout: boolean;
}

export interface GzPlanRow {
  rowNumber: number;
  bin: string;
  customerName: string;
  website: string;
  email: string;
  phone: string;
  reportingAdministrator: string;
  address: string;
  directorName: string;
  planDate: string;
  truCode: string;
  itemName: string;
  itemUrl: string;
  unit: string;
  quantity: string;
  price: string;
  extraSpec: string;
  keyword: string;
  planNumber: string;
  planId: string;
  plannedMonth: string;
  status: string;
  amount: string;
  purchaseMethod: string;
  customerUrl: string;
  planUrl: string;
  shortSpec: string;
  extraDescription: string;
  deliveryPlace: string;
}

interface PushStats {
  read: number;
  candidate: number;
  dryRun: number;
  created: number;
  existing: number;
  skipped: number;
  failed: number;
}

interface ImportFieldDefinition {
  key: string;
  label: string;
  xmlId: string;
  fieldName?: string;
  fallbackCode?: string;
  getValue: (row: GzPlanRow) => string;
}

interface BitrixUserField {
  FIELD_NAME: string;
  XML_ID?: string;
  EDIT_FORM_LABEL?: unknown;
  LIST_COLUMN_LABEL?: unknown;
  LIST_FILTER_LABEL?: unknown;
  USER_TYPE_ID?: string;
}

interface LeadDetailsSection {
  name: string;
  title: string;
  type: "section";
  elements: Array<{
    name: string;
    optionFlags?: string | number;
    options?: Record<string, unknown>;
  }>;
}

const DEFAULT_INPUT = "exports/gz-plans-2026-jun-dec-approved-fresh-2026-06-30.xlsx";
const ORIGINATOR_ID = "scrape2lead-gz-plans";
const IMPORT_SECTION_TITLE = "Импорт";
const IMPORT_FIELD_DEFINITIONS: ImportFieldDefinition[] = [
  {
    key: "purchaseMethod",
    label: "Способ закупки",
    xmlId: "scrape2lead_gz_purchase_method",
    fallbackCode: "UF_CRM_1713874828510",
    getValue: (row) => row.purchaseMethod
  },
  {
    key: "itemName",
    label: "Наименование",
    xmlId: "scrape2lead_gz_item_name",
    fallbackCode: "UF_CRM_1713874845756",
    getValue: (row) => row.itemName
  },
  {
    key: "price",
    label: "Цена за ед.",
    xmlId: "scrape2lead_gz_price",
    fallbackCode: "UF_CRM_1713874858791",
    getValue: (row) => row.price
  },
  {
    key: "quantity",
    label: "Кол-во",
    xmlId: "scrape2lead_gz_quantity",
    fallbackCode: "UF_CRM_1713874871715",
    getValue: (row) => row.quantity
  },
  {
    key: "customerName",
    label: "Заказчик",
    xmlId: "scrape2lead_gz_customer_name",
    fallbackCode: "UF_CRM_1713874888434",
    getValue: (row) => row.customerName
  },
  {
    key: "bin",
    label: "БИН заказчика",
    xmlId: "scrape2lead_gz_customer_bin",
    fallbackCode: "UF_CRM_1713874902207",
    getValue: (row) => row.bin
  },
  {
    key: "status",
    label: "Статус",
    xmlId: "scrape2lead_gz_status",
    fallbackCode: "UF_CRM_1713874909541",
    getValue: (row) => row.status
  },
  {
    key: "reportingAdministrator",
    label: "Администратор отчетности",
    xmlId: "scrape2lead_gz_reporting_administrator",
    fieldName: "UF_CRM_S2L_GZ_ADMIN",
    getValue: (row) => row.reportingAdministrator
  },
  {
    key: "address",
    label: "Полный адрес",
    xmlId: "scrape2lead_gz_full_address",
    fieldName: "UF_CRM_S2L_GZ_ADDRESS",
    getValue: (row) => row.address
  },
  {
    key: "directorName",
    label: "Руководитель ФИО",
    xmlId: "scrape2lead_gz_director_name",
    fieldName: "UF_CRM_S2L_GZ_DIRECTOR",
    getValue: (row) => row.directorName
  },
  {
    key: "planDate",
    label: "Дата акта утверждения плана",
    xmlId: "scrape2lead_gz_plan_approval_date",
    fieldName: "UF_CRM_S2L_GZ_APPROVAL_DATE",
    getValue: (row) => row.planDate
  },
  {
    key: "truCode",
    label: "Код ТРУ",
    xmlId: "scrape2lead_gz_tru_code",
    fieldName: "UF_CRM_S2L_GZ_TRU",
    getValue: (row) => row.truCode
  },
  {
    key: "itemUrl",
    label: "Ссылка на наименование",
    xmlId: "scrape2lead_gz_item_url",
    fieldName: "UF_CRM_S2L_GZ_ITEM_URL",
    getValue: (row) => row.itemUrl
  },
  {
    key: "unit",
    label: "Единица измерения",
    xmlId: "scrape2lead_gz_unit",
    fieldName: "UF_CRM_S2L_GZ_UNIT",
    getValue: (row) => row.unit
  },
  {
    key: "extraSpec",
    label: "Дополнительная характеристика",
    xmlId: "scrape2lead_gz_extra_spec",
    fieldName: "UF_CRM_S2L_GZ_EXTRA_SPEC",
    getValue: (row) => row.extraSpec
  },
  {
    key: "keyword",
    label: "Ключевое слово",
    xmlId: "scrape2lead_gz_keyword",
    fieldName: "UF_CRM_S2L_GZ_KEYWORD",
    getValue: (row) => row.keyword
  },
  {
    key: "planNumber",
    label: "№ пункта плана",
    xmlId: "scrape2lead_gz_plan_number",
    fieldName: "UF_CRM_S2L_GZ_PLAN_NO",
    getValue: (row) => row.planNumber
  },
  {
    key: "planId",
    label: "ID пункта API",
    xmlId: "scrape2lead_gz_plan_id",
    fieldName: "UF_CRM_S2L_GZ_PLAN_ID",
    getValue: (row) => row.planId
  },
  {
    key: "plannedMonth",
    label: "Планируемый срок",
    xmlId: "scrape2lead_gz_planned_month",
    fieldName: "UF_CRM_S2L_GZ_MONTH",
    getValue: (row) => row.plannedMonth
  },
  {
    key: "amount",
    label: "Плановая сумма",
    xmlId: "scrape2lead_gz_amount",
    fieldName: "UF_CRM_S2L_GZ_AMOUNT",
    getValue: (row) => formatMoneyForBitrixRobot(row.amount)
  },
  {
    key: "customerUrl",
    label: "Ссылка на заказчика",
    xmlId: "scrape2lead_gz_customer_url",
    fieldName: "UF_CRM_S2L_GZ_CUSTOMER_URL",
    getValue: (row) => row.customerUrl
  },
  {
    key: "planUrl",
    label: "Ссылка на пункт плана",
    xmlId: "scrape2lead_gz_plan_url",
    fieldName: "UF_CRM_S2L_GZ_PLAN_URL",
    getValue: (row) => row.planUrl
  },
  {
    key: "shortSpec",
    label: "Краткая характеристика",
    xmlId: "scrape2lead_gz_short_spec",
    fieldName: "UF_CRM_S2L_GZ_SHORT_SPEC",
    getValue: (row) => row.shortSpec
  },
  {
    key: "extraDescription",
    label: "Дополнительное описание",
    xmlId: "scrape2lead_gz_extra_description",
    fieldName: "UF_CRM_S2L_GZ_EXTRA_DESC",
    getValue: (row) => row.extraDescription
  },
  {
    key: "deliveryPlace",
    label: "Место поставки",
    xmlId: "scrape2lead_gz_delivery_place",
    fieldName: "UF_CRM_S2L_GZ_DELIVERY",
    getValue: (row) => row.deliveryPlace
  }
];

const DEFAULT_IMPORT_FIELD_CODES = Object.fromEntries(
  IMPORT_FIELD_DEFINITIONS
    .filter((definition) => definition.fallbackCode)
    .map((definition) => [definition.key, definition.fallbackCode as string])
);

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: DEFAULT_INPUT,
    execute: false,
    limit: null,
    delayMs: 350,
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    assignedById: parseOptionalInt(process.env.BITRIX24_ASSIGNED_BY_ID),
    skipExistingCheck: false,
    planId: null,
    updateExisting: false,
    ensureFields: false,
    ensureLayout: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.inputPath = argv[++i] ?? args.inputPath;
    } else if (arg === "--execute") {
      args.execute = true;
    } else if (arg === "--limit") {
      args.limit = parseOptionalInt(argv[++i]);
    } else if (arg === "--delay-ms") {
      args.delayMs = Number(argv[++i] ?? args.delayMs);
    } else if (arg === "--webhook-url") {
      args.webhookUrl = argv[++i]?.trim() || null;
    } else if (arg === "--assigned-by-id") {
      args.assignedById = parseOptionalInt(argv[++i]);
    } else if (arg === "--skip-existing-check") {
      args.skipExistingCheck = true;
    } else if (arg === "--plan-id") {
      args.planId = argv[++i]?.trim() || null;
    } else if (arg === "--update-existing") {
      args.updateExisting = true;
    } else if (arg === "--ensure-fields") {
      args.ensureFields = true;
    } else if (arg === "--ensure-layout") {
      args.ensureLayout = true;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const needsBitrixClient = args.execute || args.ensureFields || args.ensureLayout;
  if (needsBitrixClient && !args.webhookUrl) {
    throw new Error("BITRIX24_WEBHOOK_URL is required for Bitrix operations");
  }
  const client = args.webhookUrl && needsBitrixClient ? new BitrixClient(args.webhookUrl) : null;
  let importFieldCodes: Record<string, string> = { ...DEFAULT_IMPORT_FIELD_CODES };

  if (client && args.ensureFields) {
    const ensured = await ensureImportUserFields(client, args.execute);
    importFieldCodes = ensured.fieldCodes;
    console.log(
      `bitrix fields: existing=${ensured.existing.length} missing=${ensured.missing.length} created=${ensured.created.length}`
    );
    if (ensured.missing.length > 0) {
      console.log(`missing fields: ${ensured.missing.map((definition) => definition.label).join(", ")}`);
    }
    if (ensured.created.length > 0) {
      console.log(`created fields: ${ensured.created.map((field) => `${field.label}=${field.code}`).join(", ")}`);
    }
  } else if (client && args.execute) {
    importFieldCodes = await resolveImportFieldCodes(client);
  }

  if (client && args.ensureLayout) {
    const layout = await ensureImportLayout(client, importFieldCodes, args.execute);
    console.log(`bitrix layout: section=${layout.sectionTitle} missing_elements=${layout.missing.length}`);
    if (layout.missing.length > 0) {
      console.log(`layout add: ${layout.missing.join(", ")}`);
    }
    if (layout.updated) {
      console.log("bitrix layout updated");
    }
  }

  if (!args.execute && (args.ensureFields || args.ensureLayout)) {
    console.log("dry-run only: pass --execute to create missing fields/update layout");
  }

  const rows = await readGzPlanRows(args.inputPath);
  const filteredRows = args.planId ? rows.filter((row) => row.planId === args.planId) : rows;
  const candidates = dedupeRows(filteredRows)
    .map((row) => ({ ...row, email: normalizeEmail(row.email) }))
    .filter((row) => row.email || row.phone || row.website);
  const limited = args.limit ? candidates.slice(0, args.limit) : candidates;
  const stats: PushStats = {
    read: rows.length,
    candidate: limited.length,
    dryRun: 0,
    created: 0,
    existing: 0,
    skipped: candidates.length - limited.length,
    failed: 0
  };

  console.log(`bitrix gz-plans: input=${args.inputPath}`);
  console.log(`mode=${args.execute ? "execute" : "dry-run"} rows=${rows.length} candidates=${candidates.length} sending=${limited.length}`);

  if (!args.execute) {
    for (const row of limited.slice(0, 10)) {
      const fields = buildLeadFields(row, args.assignedById, importFieldCodes);
      stats.dryRun += 1;
      console.log(`[dry-run] ${fields.ORIGIN_ID} | ${fields.COMPANY_TITLE} | email=${row.email || "-"} phone=${row.phone || "-"} web=${row.website || "-"}`);
    }
    if (limited.length > 10) {
      console.log(`[dry-run] ... ${limited.length - 10} more`);
    }
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (!client) {
    throw new Error("Bitrix client was not initialized");
  }
  for (const row of limited) {
    const fields = buildLeadFields(row, args.assignedById, importFieldCodes);
    try {
      if (!args.skipExistingCheck) {
        const existingId = await client.findLeadId(String(fields.ORIGINATOR_ID), String(fields.ORIGIN_ID));
        if (existingId) {
          if (args.updateExisting) {
            await client.updateLead(existingId, fields);
            stats.existing += 1;
            console.log(`[updated] ${fields.ORIGIN_ID} -> lead ${existingId}`);
          } else {
            stats.existing += 1;
            console.log(`[existing] ${fields.ORIGIN_ID} -> lead ${existingId}`);
          }
          await sleep(args.delayMs);
          continue;
        }
      }

      const id = await client.addLead(fields);
      stats.created += 1;
      console.log(`[created] ${fields.ORIGIN_ID} -> lead ${id}`);
    } catch (error) {
      stats.failed += 1;
      console.error(`[failed] ${fields.ORIGIN_ID}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(args.delayMs);
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async findLeadId(originatorId: string, originId: string): Promise<string | null> {
    const response = await this.call("crm.lead.list", {
      filter: {
        ORIGINATOR_ID: originatorId,
        ORIGIN_ID: originId
      },
      select: ["ID"]
    });
    const rows = Array.isArray(response.result) ? response.result : [];
    const first = rows[0] as { ID?: string | number } | undefined;
    return first?.ID ? String(first.ID) : null;
  }

  async addLead(fields: Record<string, unknown>): Promise<string> {
    const response = await this.call("crm.lead.add", {
      fields,
      params: {
        REGISTER_SONET_EVENT: "Y"
      }
    });
    return String(response.result);
  }

  async updateLead(id: string, fields: Record<string, unknown>): Promise<void> {
    await this.call("crm.lead.update", {
      id,
      fields
    });
  }

  async listLeadUserFields(): Promise<BitrixUserField[]> {
    const response = await this.call("crm.lead.userfield.list", {
      order: {
        SORT: "ASC"
      }
    });
    return Array.isArray(response.result) ? response.result as BitrixUserField[] : [];
  }

  async addLeadUserField(definition: ImportFieldDefinition, sort: number): Promise<void> {
    await this.call("crm.lead.userfield.add", {
      fields: {
        FIELD_NAME: definition.fieldName,
        USER_TYPE_ID: "string",
        XML_ID: definition.xmlId,
        SORT: String(sort),
        EDIT_FORM_LABEL: definition.label,
        LIST_COLUMN_LABEL: definition.label,
        LIST_FILTER_LABEL: definition.label,
        ERROR_MESSAGE: "",
        HELP_MESSAGE: ""
      }
    });
  }

  async getLeadDetailsConfiguration(leadCustomerType: number): Promise<LeadDetailsSection[]> {
    const response = await this.call("crm.lead.details.configuration.get", {
      scope: "C",
      leadCustomerType
    });
    return Array.isArray(response.result) ? response.result as LeadDetailsSection[] : [];
  }

  async setLeadDetailsConfiguration(leadCustomerType: number, data: LeadDetailsSection[]): Promise<void> {
    await this.call("crm.lead.details.configuration.set", {
      scope: "C",
      leadCustomerType,
      data
    });
  }

  private async call(method: string, body: unknown): Promise<{ result: unknown; error?: string; error_description?: string }> {
    const url = `${this.baseUrl}/${method}.json`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }
}

async function readGzPlanRows(inputPath: string): Promise<GzPlanRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`No worksheet found in ${inputPath}`);
  }

  const rows: GzPlanRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const planId = cellText(row.getCell(19));
    if (!planId) return;
    rows.push({
      rowNumber,
      bin: cellText(row.getCell(1)),
      customerName: cellText(row.getCell(2)),
      website: cellText(row.getCell(3)),
      email: cellText(row.getCell(4)),
      phone: cellText(row.getCell(5)),
      reportingAdministrator: cellText(row.getCell(6)),
      address: cellText(row.getCell(7)),
      directorName: cellText(row.getCell(8)),
      planDate: cellText(row.getCell(9)),
      truCode: cellText(row.getCell(10)),
      itemName: cellText(row.getCell(11)),
      itemUrl: cellText(row.getCell(12)),
      unit: cellText(row.getCell(13)),
      quantity: cellText(row.getCell(14)),
      price: cellText(row.getCell(15)),
      extraSpec: cellText(row.getCell(16)),
      keyword: cellText(row.getCell(17)),
      planNumber: cellText(row.getCell(18)),
      planId,
      plannedMonth: cellText(row.getCell(20)),
      status: cellText(row.getCell(21)),
      amount: cellText(row.getCell(22)),
      purchaseMethod: cellText(row.getCell(23)),
      customerUrl: cellText(row.getCell(24)),
      planUrl: cellText(row.getCell(25)),
      shortSpec: cellText(row.getCell(26)),
      extraDescription: cellText(row.getCell(27)),
      deliveryPlace: cellText(row.getCell(28))
    });
  });
  return rows;
}

export function buildLeadFields(row: GzPlanRow, assignedById: number | null, importFieldCodes: Record<string, string>): Record<string, unknown> {
  const comments = [
    `GZ plan ID: ${row.planId}`,
    `BIN: ${row.bin || "-"}`,
    `Customer: ${row.customerName || "-"}`,
    `Reporting administrator: ${row.reportingAdministrator || "-"}`,
    `Director: ${row.directorName || "-"}`,
    `Address: ${row.address || "-"}`,
    `Item: ${row.itemName || "-"}`,
    `TRU: ${row.truCode || "-"}`,
    `Keyword: ${row.keyword || "-"}`,
    `Status: ${row.status || "-"}`,
    `Planned month: ${row.plannedMonth || "-"}`,
    `Amount: ${row.amount || "-"}`,
    `Purchase method: ${row.purchaseMethod || "-"}`,
    `Customer URL: ${row.customerUrl || "-"}`,
    `Plan URL: ${row.planUrl || "-"}`
  ].join("\n");

  const fields: Record<string, unknown> = {
    TITLE: buildTitle(row),
    COMPANY_TITLE: row.customerName || row.bin || `GZ plan ${row.planId}`,
    COMMENTS: comments,
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: "scrape2lead gz-plans",
    ORIGINATOR_ID,
    ORIGIN_ID: `gz-plan:${row.planId}`,
    ADDRESS: row.address || undefined,
    CURRENCY_ID: "KZT",
    OPPORTUNITY: parseMoney(row.amount)
  };
  Object.assign(fields, buildImportCustomFields(row, importFieldCodes));

  if (assignedById) {
    fields.ASSIGNED_BY_ID = assignedById;
  }
  if (row.phone) {
    fields.PHONE = [{ VALUE: row.phone, VALUE_TYPE: "WORK" }];
  }
  if (row.email) {
    fields.EMAIL = [{ VALUE: row.email, VALUE_TYPE: "WORK" }];
  }
  if (row.website) {
    fields.WEB = [{ VALUE: row.website, VALUE_TYPE: "WORK" }];
  }

  return stripUndefined(fields);
}

function buildImportCustomFields(row: GzPlanRow, importFieldCodes: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const definition of IMPORT_FIELD_DEFINITIONS) {
    const code = importFieldCodes[definition.key];
    const value = definition.getValue(row);
    if (code && value.trim()) {
      fields[code] = value;
    }
  }
  return fields;
}

async function ensureImportUserFields(
  client: BitrixClient,
  execute: boolean
): Promise<{
  fieldCodes: Record<string, string>;
  existing: ImportFieldDefinition[];
  missing: ImportFieldDefinition[];
  created: Array<{ label: string; code: string }>;
}> {
  let userFields = await client.listLeadUserFields();
  const existing: ImportFieldDefinition[] = [];
  const missing: ImportFieldDefinition[] = [];
  const created: Array<{ label: string; code: string }> = [];

  for (const definition of IMPORT_FIELD_DEFINITIONS) {
    if (findUserField(userFields, definition)) {
      existing.push(definition);
    } else {
      missing.push(definition);
    }
  }

  if (execute) {
    let sort = 700;
    for (const definition of missing) {
      await client.addLeadUserField(definition, sort);
      sort += 10;
    }
    userFields = await client.listLeadUserFields();
    for (const definition of missing) {
      const field = findUserField(userFields, definition);
      if (!field) {
        throw new Error(`Bitrix did not return created field "${definition.label}"`);
      }
      created.push({ label: definition.label, code: field.FIELD_NAME });
    }
  }

  return {
    fieldCodes: mapImportFieldCodes(userFields),
    existing,
    missing,
    created
  };
}

async function resolveImportFieldCodes(client: BitrixClient): Promise<Record<string, string>> {
  return mapImportFieldCodes(await client.listLeadUserFields());
}

async function ensureImportLayout(
  client: BitrixClient,
  importFieldCodes: Record<string, string>,
  execute: boolean
): Promise<{ sectionTitle: string; missing: string[]; updated: boolean }> {
  const fieldCodes = IMPORT_FIELD_DEFINITIONS
    .map((definition) => importFieldCodes[definition.key])
    .filter((code): code is string => Boolean(code));
  const sectionTitle = IMPORT_SECTION_TITLE;
  const missingAll = new Set<string>();
  let updated = false;

  for (const leadCustomerType of [1, 2]) {
    const configuration = await client.getLeadDetailsConfiguration(leadCustomerType);
    const section = getOrCreateImportSection(configuration);
    const existingNames = new Set(section.elements.map((element) => element.name));
    const missing = fieldCodes.filter((code) => !existingNames.has(code));
    for (const code of missing) {
      missingAll.add(code);
    }
    if (execute && missing.length > 0) {
      for (const code of missing) {
        section.elements.push({
          name: code,
          optionFlags: "1"
        });
      }
      await client.setLeadDetailsConfiguration(leadCustomerType, configuration);
      updated = true;
    }
  }

  return {
    sectionTitle,
    missing: [...missingAll],
    updated
  };
}

function getOrCreateImportSection(configuration: LeadDetailsSection[]): LeadDetailsSection {
  const existing = configuration.find((section) => section.type === "section" && section.title.toLowerCase() === IMPORT_SECTION_TITLE.toLowerCase());
  if (existing) {
    return existing;
  }
  const created: LeadDetailsSection = {
    name: "scrape2lead_import",
    title: IMPORT_SECTION_TITLE,
    type: "section",
    elements: []
  };
  configuration.push(created);
  return created;
}

function mapImportFieldCodes(userFields: BitrixUserField[]): Record<string, string> {
  const result: Record<string, string> = { ...DEFAULT_IMPORT_FIELD_CODES };
  for (const definition of IMPORT_FIELD_DEFINITIONS) {
    const field = findUserField(userFields, definition);
    if (field) {
      result[definition.key] = field.FIELD_NAME;
    }
  }
  return result;
}

function findUserField(userFields: BitrixUserField[], definition: ImportFieldDefinition): BitrixUserField | undefined {
  return userFields.find((field) => {
    if (field.FIELD_NAME === definition.fallbackCode) return true;
    if (field.FIELD_NAME === definition.fieldName) return true;
    if (field.XML_ID === definition.xmlId) return true;
    return getUserFieldLabels(field).some((label) => label.toLowerCase() === definition.label.toLowerCase());
  });
}

function getUserFieldLabels(field: BitrixUserField): string[] {
  return [field.EDIT_FORM_LABEL, field.LIST_COLUMN_LABEL, field.LIST_FILTER_LABEL]
    .flatMap((label) => {
      if (!label) return [];
      if (typeof label === "string") return [label];
      if (typeof label === "object") return Object.values(label).map((value) => String(value));
      return [String(label)];
    })
    .filter(Boolean);
}

function buildTitle(row: GzPlanRow): string {
  const item = row.itemName || row.keyword || "GZ plan";
  const company = row.customerName || row.bin || row.planId;
  const displayPlanNumber = row.planNumber || row.planId;
  return `[GZ ${displayPlanNumber}] ${company} - ${item}`.slice(0, 250);
}

function dedupeRows(rows: GzPlanRow[]): GzPlanRow[] {
  const seen = new Set<string>();
  const result: GzPlanRow[] = [];
  for (const row of rows) {
    if (seen.has(row.planId)) continue;
    seen.add(row.planId);
    result.push(row);
  }
  return result;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value && value.text) return String(value.text).trim();
    if ("hyperlink" in value && value.hyperlink) return String(value.hyperlink).trim();
    if ("result" in value && value.result != null) return String(value.result).trim();
  }
  return String(value).trim();
}

export function formatMoneyForBitrixRobot(value: string): string {
  const parsed = parseMoney(value);
  return parsed === undefined ? "" : parsed.toFixed(2);
}

function parseMoney(value: string): number | undefined {
  const normalized = normalizeMoneyText(value);
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeMoneyText(value: string): string {
  const compact = value.replace(/[\s\u00a0]+/g, "").trim();
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    return compact
      .replaceAll(thousandsSeparator, "")
      .replace(decimalSeparator, ".");
  }
  if (lastComma >= 0) {
    return compact.replace(",", ".");
  }
  return compact;
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().replace(/[.,;:]+$/g, "");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function stripEmptyStrings(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
