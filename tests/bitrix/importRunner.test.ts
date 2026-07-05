import { describe, expect, it } from "vitest";
import { parseImportConfig, type ImportConfig } from "../../src/bitrix/importConfig.js";
import type { ImportRow } from "../../src/bitrix/importPlanner.js";
import { runImport, type BitrixCrmGateway } from "../../src/bitrix/importRunner.js";

function leadConfig(): ImportConfig {
  return parseImportConfig({
    entity: "lead",
    originatorId: "xlsx-import",
    originIdTemplate: "order:{orderId}",
    columns: [
      { key: "orderId", header: "Номер" },
      { key: "company", header: "Компания" },
      { key: "bin", header: "БИН" },
      { key: "phone", header: "Телефон" }
    ],
    required: ["orderId", "company"],
    fields: {
      TITLE: { template: "[{orderId}] {company}" },
      PHONE: { column: "phone", transform: "phone" }
    },
    duplicateChecks: [
      { reason: "same phone", filter: { PHONE: { column: "phone", transform: "phone" } } }
    ],
    defaults: { assignedById: 7, sourceId: "WEB" },
    company: {
      searchField: "UF_CRM_BIN",
      searchColumn: "bin",
      originIdTemplate: "company:{bin}",
      fields: { TITLE: { column: "company" } }
    }
  });
}

interface GatewayCall {
  method: string;
  entity: string;
  payload: unknown;
}

function makeGateway(overrides: {
  byOrigin?: Record<string, { ID: string }>;
  firstMatches?: Array<{ match: Record<string, unknown>; result: Record<string, unknown> }>;
} = {}): { gateway: BitrixCrmGateway; calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  const gateway: BitrixCrmGateway = {
    async findByOrigin(entity, originatorId, originId) {
      calls.push({ method: "findByOrigin", entity, payload: { originatorId, originId } });
      return overrides.byOrigin?.[`${entity}:${originId}`] ?? null;
    },
    async findFirst(entity, filter) {
      calls.push({ method: "findFirst", entity, payload: filter });
      for (const { match, result } of overrides.firstMatches ?? []) {
        if (JSON.stringify(match) === JSON.stringify(filter)) return result;
      }
      return null;
    },
    async add(entity, fields) {
      calls.push({ method: "add", entity, payload: fields });
      return entity === "company" ? "500" : "100";
    },
    async update(entity, id, fields) {
      calls.push({ method: "update", entity, payload: { id, fields } });
    }
  };
  return { gateway, calls };
}

const rows: ImportRow[] = [
  { rowNumber: 2, values: { orderId: "1", company: "ТОО Ромашка", bin: "123456789012", phone: "+77770000001" } },
  { rowNumber: 3, values: { orderId: "2", company: "ТОО Дубль", bin: "", phone: "+77770000002" } },
  { rowNumber: 4, values: { orderId: "3", company: "ТОО Существующая", bin: "", phone: "" } },
  { rowNumber: 5, values: { orderId: "4", company: "", bin: "", phone: "" } }
];

describe("runImport", () => {
  it("plans create/duplicate/existing/skip without writing in dry-run mode", async () => {
    const { gateway, calls } = makeGateway({
      byOrigin: { "lead:order:3": { ID: "42" } },
      firstMatches: [
        { match: { PHONE: "+77770000002" }, result: { ID: "9", ORIGINATOR_ID: "other", ORIGIN_ID: "x" } }
      ]
    });

    const { counts, plan } = await runImport(gateway, leadConfig(), rows, {
      execute: false,
      updateExisting: false,
      log: () => {}
    });

    expect(counts).toEqual({ create: 1, update: 0, existing: 1, duplicate: 1, skip: 1, failed: 0 });
    expect(plan.map((item) => item.action)).toEqual(["create", "duplicate", "existing", "skip"]);
    expect(plan[1].duplicateReason).toBe("same phone");
    expect(plan[3].issues).toEqual(['missing required column "company"']);
    expect(calls.filter((call) => call.method === "add" || call.method === "update")).toEqual([]);
  });

  it("creates the lead with origin id, defaults, and a linked company on execute", async () => {
    const { gateway, calls } = makeGateway();

    const { counts } = await runImport(gateway, leadConfig(), rows.slice(0, 1), {
      execute: true,
      updateExisting: false,
      log: () => {}
    });

    expect(counts.create).toBe(1);
    const companyAdd = calls.find((call) => call.method === "add" && call.entity === "company");
    expect(companyAdd?.payload).toMatchObject({
      TITLE: "ТОО Ромашка",
      UF_CRM_BIN: "123456789012",
      ORIGINATOR_ID: "xlsx-import",
      ORIGIN_ID: "company:123456789012",
      ASSIGNED_BY_ID: 7
    });

    const leadAdd = calls.find((call) => call.method === "add" && call.entity === "lead");
    expect(leadAdd?.payload).toMatchObject({
      TITLE: "[1] ТОО Ромашка",
      PHONE: [{ VALUE: "+77770000001", VALUE_TYPE: "WORK" }],
      ORIGINATOR_ID: "xlsx-import",
      ORIGIN_ID: "order:1",
      ASSIGNED_BY_ID: 7,
      SOURCE_ID: "WEB",
      COMPANY_ID: "500"
    });
  });

  it("reuses an existing company found by the search field", async () => {
    const { gateway, calls } = makeGateway({
      firstMatches: [
        { match: { UF_CRM_BIN: "123456789012" }, result: { ID: "321" } }
      ]
    });

    await runImport(gateway, leadConfig(), rows.slice(0, 1), {
      execute: true,
      updateExisting: false,
      log: () => {}
    });

    expect(calls.some((call) => call.method === "add" && call.entity === "company")).toBe(false);
    const leadAdd = calls.find((call) => call.method === "add" && call.entity === "lead");
    expect(leadAdd?.payload).toMatchObject({ COMPANY_ID: "321" });
  });

  it("updates existing entities when updateExisting is enabled", async () => {
    const { gateway, calls } = makeGateway({
      byOrigin: { "lead:order:1": { ID: "42" } }
    });

    const { counts } = await runImport(gateway, leadConfig(), rows.slice(0, 1), {
      execute: true,
      updateExisting: true,
      log: () => {}
    });

    expect(counts).toMatchObject({ update: 1, create: 0, failed: 0 });
    const update = calls.find((call) => call.method === "update");
    expect(update?.payload).toMatchObject({
      id: "42",
      fields: { TITLE: "[1] ТОО Ромашка" }
    });
  });

  it("counts failures without aborting the run", async () => {
    const { gateway } = makeGateway();
    const failing: BitrixCrmGateway = {
      ...gateway,
      async add() {
        throw new Error("boom");
      }
    };

    const { counts } = await runImport(failing, leadConfig(), rows.slice(0, 1), {
      execute: true,
      updateExisting: false,
      log: () => {}
    });

    expect(counts).toMatchObject({ create: 0, failed: 1 });
  });

  it("rejects duplicate checks on fields the entity does not have", async () => {
    const { gateway } = makeGateway();
    const withFields: BitrixCrmGateway = {
      ...gateway,
      async listFields() {
        return { ID: {}, TITLE: {}, OPPORTUNITY: {} };
      }
    };

    await expect(runImport(withFields, leadConfig(), rows.slice(0, 1), {
      execute: false,
      updateExisting: false,
      log: () => {}
    })).rejects.toThrow(/PHONE.*ignore the filter/s);
  });

  it("accepts duplicate checks when the entity schema includes the filter fields", async () => {
    const { gateway } = makeGateway();
    const withFields: BitrixCrmGateway = {
      ...gateway,
      async listFields() {
        return { ID: {}, TITLE: {}, PHONE: {} };
      }
    };

    const { counts } = await runImport(withFields, leadConfig(), rows.slice(0, 1), {
      execute: false,
      updateExisting: false,
      log: () => {}
    });
    expect(counts.create).toBe(1);
  });

  it("applies the row limit before planning", async () => {
    const { gateway, calls } = makeGateway();

    const { plan } = await runImport(gateway, leadConfig(), rows, {
      execute: false,
      updateExisting: false,
      limit: 1,
      log: () => {}
    });

    expect(plan).toHaveLength(1);
    expect(calls.filter((call) => call.method === "findByOrigin")).toHaveLength(1);
  });
});
