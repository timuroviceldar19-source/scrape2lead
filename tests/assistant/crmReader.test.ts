import { describe, expect, it } from "vitest";
import { CrmReader, CrmReadError } from "../../src/assistant/crmReader.js";

const WEBHOOK = "https://example.bitrix24.kz/rest/7/secretcode/";

function reader(results: Record<string, unknown>, totals: Record<string, number> = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).replace(WEBHOOK, "");
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    if (!(method in results)) return new Response(JSON.stringify({ error: "NOT_MOCKED", error_description: method }), { status: 400 });
    const value = results[method];
    const body = JSON.parse(String(init?.body ?? "{}"));
    const result = typeof value === "function" ? (value as (b: Record<string, unknown>) => unknown)(body) : value;
    // страница из 50 строк означает, что дальше есть ещё: Bitrix отдаёт `next`
    const next = Array.isArray(result) && result.length === 50 ? Number(body.start ?? 0) + 50 : undefined;
    return new Response(JSON.stringify({ result, total: totals[method], next }), { status: 200 });
  }) as typeof fetch;
  return { crm: new CrmReader({ webhookUrl: WEBHOOK, fetchFn }), calls };
}

// Ответ crm.deal.fields: подписи полей лежат в formLabel/listLabel (crm.deal.fields подписей не отдаёт).
const USER_FIELDS = {
  TITLE: { type: "string", title: "Название", formLabel: "Название" },
  UF_CRM_PLAN_ID: { type: "string", title: "UF_CRM_PLAN_ID", formLabel: "ID пункта плана", listLabel: "ID плана" },
  UF_CRM_BIN: { type: "string", title: "UF_CRM_BIN", formLabel: "", listLabel: "БИН заказчика" },
  UF_CRM_FLAG: { type: "boolean", title: "UF_CRM_FLAG", formLabel: "Флаг" },
  UF_CRM_ENUM: { type: "enumeration", title: "UF_CRM_ENUM", formLabel: "Тип" },
  UF_CRM_WATCHERS: { type: "employee", title: "UF_CRM_WATCHERS", formLabel: "Наблюдатели тендера" },
  UF_CRM_EMPTY: { type: "string", title: "UF_CRM_EMPTY", formLabel: "Пустое" }
};

const DEAL = {
  ID: "48311",
  TITLE: "[GZ 88099169] Заказчик - Панель",
  STAGE_ID: "C41:PREPARATION",
  OPPORTUNITY: "4800000.00",
  COMPANY_ID: "8477",
  ORIGIN_ID: "gz-plan:88183993",
  UF_CRM_PLAN_ID: "88099169",
  UF_CRM_BIN: "120540004946",
  UF_CRM_FLAG: "0",
  UF_CRM_ENUM: "765",
  UF_CRM_WATCHERS: ["1899", "2179"],
  UF_CRM_EMPTY: ""
};

describe("CrmReader allowlist", () => {
  it("lets the read-only field catalog through", async () => {
    const { crm, calls } = reader({ "crm.deal.fields": {} });

    await expect(crm.call("crm.deal.fields", {})).resolves.toEqual({});
    expect(calls).toHaveLength(1);
  });

  it.each(["crm.deal.update", "crm.deal.add", "crm.contact.add", "crm.contact.update", "crm.contact.delete", "crm.activity.add", "crm.activity.update", "crm.activity.delete", "im.message.add", "crm.deal.delete"])(
    "refuses %s before any network call",
    async (method) => {
      const { crm, calls } = reader({});

      await expect(crm.call(method, {})).rejects.toBeInstanceOf(CrmReadError);
      expect(calls).toHaveLength(0);
    }
  );
});

describe("CrmReader.getDealSummary", () => {
  it("labels custom fields from the form label (list label as fallback), drops empty, boolean-false, enumeration and employee ids", async () => {
    const { crm } = reader({ "crm.deal.get": DEAL, "crm.deal.fields": USER_FIELDS });

    const deal = await crm.getDealSummary(48311);

    expect(deal).toMatchObject({
      id: 48311,
      title: "[GZ 88099169] Заказчик - Панель",
      stageId: "C41:PREPARATION",
      amount: 4800000,
      companyId: 8477,
      originId: "gz-plan:88183993",
      kind: "plan"
    });
    expect(deal.fields).toEqual([
      { label: "ID пункта плана", value: "88099169" },
      { label: "БИН заказчика", value: "120540004946" }
    ]);
  });

  it("classifies lot deals by the origin id and reads the field labels only once", async () => {
    const { crm, calls } = reader({
      "crm.deal.get": { ...DEAL, ORIGIN_ID: "gz-lot:83132229-ЗЦП1" },
      "crm.deal.fields": USER_FIELDS
    });

    expect((await crm.getDealSummary(1)).kind).toBe("lot");
    await crm.getDealSummary(2);

    expect(calls.filter((c) => c.method === "crm.deal.fields")).toHaveLength(1);
  });
});

describe("CrmReader.getDealSummary company", () => {
  const COMPANY = { ID: "8477", TITLE: 'АО "Центр электронных финансов"', ORIGIN_ID: "071140005693" };

  it("adds the linked company and takes its BIN from the company origin id", async () => {
    const { crm, calls } = reader({ "crm.deal.get": DEAL, "crm.deal.fields": USER_FIELDS, "crm.company.get": COMPANY });

    const deal = await crm.getDealSummary(48311);

    expect(deal.company).toEqual({ id: 8477, title: 'АО "Центр электронных финансов"', bin: "071140005693" });
    expect(calls.find((c) => c.method === "crm.company.get")?.body).toEqual({ id: 8477 });
  });

  it("reads the BIN from the origin id the robot writes for companies (gz-company:<BIN>)", async () => {
    const { crm } = reader({ "crm.deal.get": DEAL, "crm.deal.fields": USER_FIELDS, "crm.company.get": { ...COMPANY, ORIGIN_ID: "gz-company:040340008429" } });

    expect((await crm.getDealSummary(1)).company?.bin).toBe("040340008429");
  });

  it("leaves the BIN empty when the origin id of the company is not a 12 digit number", async () => {
    const { crm } = reader({ "crm.deal.get": DEAL, "crm.deal.fields": USER_FIELDS, "crm.company.get": { ...COMPANY, ORIGIN_ID: "import-5" } });

    expect((await crm.getDealSummary(1)).company).toEqual({ id: 8477, title: 'АО "Центр электронных финансов"', bin: null });
  });

  it("still returns the deal when the company cannot be read", async () => {
    const { crm } = reader({ "crm.deal.get": DEAL, "crm.deal.fields": USER_FIELDS });

    const deal = await crm.getDealSummary(1);

    expect(deal.title).toBe("[GZ 88099169] Заказчик - Панель");
    expect(deal.company).toBeNull();
  });

  it("does not ask for a company when the deal has none", async () => {
    const { crm, calls } = reader({ "crm.deal.get": { ...DEAL, COMPANY_ID: "0" }, "crm.deal.fields": USER_FIELDS });

    expect((await crm.getDealSummary(1)).company).toBeNull();
    expect(calls.some((c) => c.method === "crm.company.get")).toBe(false);
  });
});

describe("CrmReader.findDeals", () => {
  it("searches by title and returns the total with short rows", async () => {
    const { crm, calls } = reader({ "crm.deal.list": [{ ID: "5", TITLE: "[GZ лот 83132229-ЗЦП1] Заказчик" }] }, { "crm.deal.list": 1 });

    const found = await crm.findDeals("83132229-ЗЦП1", { limit: 5 });

    expect(found).toEqual({ total: 1, deals: [{ id: 5, title: "[GZ лот 83132229-ЗЦП1] Заказчик" }] });
    expect(calls[0].body).toMatchObject({ filter: { "%TITLE": "83132229-ЗЦП1" }, select: ["ID", "TITLE"] });
  });

  it("tells how many deals match, not only how many were returned", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ID: String(i + 1), TITLE: `Ноутбук ${i}` }));
    const { crm } = reader({ "crm.deal.list": rows }, { "crm.deal.list": 83 });

    const found = await crm.findDeals("Ноутбук", { limit: 5 });

    expect(found.total).toBe(83);
    expect(found.deals).toHaveLength(5);
  });

  it("looks only at the open deals of one manager when asked", async () => {
    const { crm, calls } = reader({ "crm.deal.list": [] });

    await crm.findDeals("Ноутбук", { userId: 2301 });

    expect(calls[0].body).toMatchObject({ filter: { "%TITLE": "Ноутбук", ASSIGNED_BY_ID: 2301, STAGE_SEMANTIC_ID: "P" } });
  });
});

describe("CrmReader.getDealSummary stage and owner", () => {
  const COMPANY = { ID: "8477", TITLE: 'АО "Центр электронных финансов"', ORIGIN_ID: "071140005693" };
  const STAGES = [{ STATUS_ID: "C43:NEW", NAME: "Новая" }];

  it("gives the stage by its name and says who is responsible", async () => {
    const { crm } = reader({
      "crm.deal.get": { ...DEAL, STAGE_ID: "C43:NEW", CATEGORY_ID: "43", ASSIGNED_BY_ID: "2301" },
      "crm.deal.fields": USER_FIELDS,
      "crm.company.get": COMPANY,
      "crm.status.list": STAGES
    });

    const deal = await crm.getDealSummary(1);

    expect(deal.stage).toBe("Новая");
    expect(deal.stageId).toBe("C43:NEW");
    expect(deal.assignedById).toBe(2301);
  });

  it("falls back to the stage code when the stage dictionary cannot be read", async () => {
    const { crm } = reader({ "crm.deal.get": { ...DEAL, STAGE_ID: "C43:NEW", CATEGORY_ID: "43" }, "crm.deal.fields": USER_FIELDS, "crm.company.get": COMPANY });

    const deal = await crm.getDealSummary(1);

    expect(deal.stage).toBe("C43:NEW");
    expect(deal.assignedById).toBeNull();
  });
});

describe("CrmReader errors", () => {
  it("reports the Bitrix error code and never the webhook address", async () => {
    const { crm } = reader({});

    const error = (await crm.getDealSummary(1).catch((e: unknown) => e)) as CrmReadError;

    expect(error).toBeInstanceOf(CrmReadError);
    expect(error.message).not.toContain("secretcode");
  });
});

describe("CrmReader.listMyDeals", () => {
  const STAGES = [
    { STATUS_ID: "C43:NEW", NAME: "Новая" },
    { STATUS_ID: "C43:WON", NAME: "Выиграна" }
  ];
  const ROWS = [
    { ID: "48667", TITLE: "[GZ лот 83132229-ЗЦП1] ГУ Аппарат акима - Компьютер", STAGE_ID: "C43:NEW", CATEGORY_ID: "43", OPPORTUNITY: "675273.92", ORIGIN_ID: "gz-lot:83132229-ЗЦП1", DATE_MODIFY: "2026-10-13T10:00:00+03:00" },
    { ID: "40361", TITLE: "№87246066 - Система виртуализации", STAGE_ID: "C99:ODD", CATEGORY_ID: "99", OPPORTUNITY: "0", ORIGIN_ID: "", DATE_MODIFY: "2026-07-02T07:20:28+03:00" }
  ];

  it("asks for the open lot deals of the manager, newest first, and never trusts CLOSEDATE", async () => {
    const { crm, calls } = reader({ "crm.deal.list": ROWS.slice(0, 1), "crm.status.list": STAGES }, { "crm.deal.list": 1222 });

    const result = await crm.listMyDeals({ userId: 2301, scope: "lots", order: "newest", limit: 60 });

    expect(calls[0].body).toMatchObject({
      filter: { ASSIGNED_BY_ID: 2301, STAGE_SEMANTIC_ID: "P", "%ORIGIN_ID": "gz-lot:" },
      order: { ID: "DESC" }
    });
    expect(JSON.stringify(calls[0].body.select)).not.toContain("CLOSEDATE");
    expect(result.total).toBe(1222);
    expect(result.deals).toEqual([
      { id: 48667, title: "[GZ лот 83132229-ЗЦП1] ГУ Аппарат акима - Компьютер", stage: "Новая", amount: 675273.92, kind: "lot", lotNumber: "83132229-ЗЦП1", modified: "2026-10-13" }
    ]);
  });

  it("lists the recently changed deals of every kind", async () => {
    const { crm, calls } = reader({ "crm.deal.list": ROWS, "crm.status.list": STAGES }, { "crm.deal.list": 2 });

    const result = await crm.listMyDeals({ userId: 2301, scope: "all", order: "recent", limit: 10 });

    expect(calls[0].body).toMatchObject({ filter: { ASSIGNED_BY_ID: 2301, STAGE_SEMANTIC_ID: "P" }, order: { DATE_MODIFY: "DESC" } });
    expect((calls[0].body.filter as Record<string, unknown>)["%ORIGIN_ID"]).toBeUndefined();
    expect(result.deals.map((d) => d.lotNumber)).toEqual(["83132229-ЗЦП1", null]);
    expect(result.deals[1]).toMatchObject({ id: 40361, kind: "other", amount: null });
  });

  it("reads the next pages of 50 until it has enough deals", async () => {
    const page = (offset: number) => Array.from({ length: 50 }, (_, i) => ({ ...ROWS[0], ID: String(1000 - offset - i) }));
    const { crm, calls } = reader({ "crm.deal.list": (body: Record<string, unknown>) => page(Number(body.start ?? 0)), "crm.status.list": STAGES }, { "crm.deal.list": 500 });

    const result = await crm.listMyDeals({ userId: 1, scope: "lots", order: "newest", limit: 80 });

    expect(result.deals).toHaveLength(80);
    expect(calls.filter((c) => c.method === "crm.deal.list").map((c) => c.body.start ?? 0)).toEqual([0, 50]);
  });

  it("shows the stage id when the stage name is unknown and reads each pipeline's stages only once", async () => {
    const { crm, calls } = reader({ "crm.deal.list": ROWS, "crm.status.list": STAGES }, { "crm.deal.list": 2 });

    const first = await crm.listMyDeals({ userId: 1, scope: "all", order: "recent", limit: 10 });
    await crm.listMyDeals({ userId: 1, scope: "all", order: "recent", limit: 10 });

    expect(first.deals.map((d) => d.stage)).toEqual(["Новая", "C99:ODD"]);
    const statusCalls = calls.filter((c) => c.method === "crm.status.list").map((c) => c.body);
    expect(statusCalls).toEqual([{ filter: { ENTITY_ID: "DEAL_STAGE_43" } }, { filter: { ENTITY_ID: "DEAL_STAGE_99" } }]);
  });

  it("returns at most the requested number of deals", async () => {
    const { crm } = reader({ "crm.deal.list": ROWS, "crm.status.list": STAGES }, { "crm.deal.list": 2 });

    expect((await crm.listMyDeals({ userId: 1, scope: "all", order: "recent", limit: 1 })).deals).toHaveLength(1);
  });

  it("lets the stage dictionary through the read-only allowlist", async () => {
    const { crm } = reader({ "crm.status.list": [] });

    await expect(crm.call("crm.status.list", {})).resolves.toEqual([]);
  });
});

describe("CrmReader.findCompanies", () => {
  const ROWS = [
    { ID: "10873", TITLE: 'Акционерное общество "Жасыл даму"', ORIGIN_ID: "gz-company:040340008429" },
    { ID: "9", TITLE: 'АО "Жасыл даму" (старая)', ORIGIN_ID: "040340008429" },
    { ID: "5", TITLE: "Без БИН", ORIGIN_ID: "" }
  ];

  it("finds companies by a part of the title and takes the BIN from either origin id format", async () => {
    const { crm, calls } = reader({ "crm.company.list": ROWS });

    expect(await crm.findCompanies("Жасыл даму", 5)).toEqual([
      { id: 10873, title: 'Акционерное общество "Жасыл даму"', bin: "040340008429" },
      { id: 9, title: 'АО "Жасыл даму" (старая)', bin: "040340008429" },
      { id: 5, title: "Без БИН", bin: null }
    ]);
    expect(calls[0].body).toMatchObject({ filter: { "%TITLE": "Жасыл даму" }, select: ["ID", "TITLE", "ORIGIN_ID"] });
  });

  it("returns no more than asked", async () => {
    const { crm } = reader({ "crm.company.list": ROWS });

    expect(await crm.findCompanies("Жасыл", 2)).toHaveLength(2);
  });

  it("is a read of the company list only: writes stay blocked", async () => {
    const { crm } = reader({});

    await expect(crm.call("crm.company.add", {})).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
  });
});


describe("CrmReader.customerInCrm", () => {
  const COMPANY = {
    ID: "10873",
    TITLE: 'Акционерное общество "Жасыл даму"',
    ORIGIN_ID: "gz-company:040340008429",
    PHONE: [{ VALUE: "87012227470" }],
    EMAIL: [{ VALUE: "info@zhasyldamu.kz" }]
  };
  const DEALS = [
    { ID: "48519", TITLE: "[GZ 88181580] Жасыл даму - Ноутбук", STAGE_ID: "C41:NEW", STAGE_SEMANTIC_ID: "P", CATEGORY_ID: "41", ASSIGNED_BY_ID: "725", DATE_CREATE: "2026-10-13T10:00:00+03:00", OPPORTUNITY: "3950000.00", CONTACT_ID: "15081" },
    { ID: "47000", TITLE: "Старая закупка - Монитор", STAGE_ID: "C9:WON", STAGE_SEMANTIC_ID: "S", CATEGORY_ID: "9", ASSIGNED_BY_ID: "559", DATE_CREATE: "2026-05-02T10:00:00+03:00", OPPORTUNITY: "1200000.00", CONTACT_ID: null },
    { ID: "46000", TITLE: "Ещё закупка - Принтер", STAGE_ID: "C9:LOSE", STAGE_SEMANTIC_ID: "F", CATEGORY_ID: "9", ASSIGNED_BY_ID: "559", DATE_CREATE: "2026-03-02T10:00:00+03:00", OPPORTUNITY: "0", CONTACT_ID: null }
  ];
  const BY_COMPANY = [
    { ID: "7001", NAME: "Наурызбаев", SECOND_NAME: "Динмухамедович", LAST_NAME: "Айбек", POST: "Руководитель службы закупок", ASSIGNED_BY_ID: "205", PHONE: [{ VALUE: "87011112233" }], EMAIL: [{ VALUE: "a@zd.kz" }], UF_CRM_HHAPPLICANTID: null },
    { ID: "7003", NAME: "Гз", LAST_NAME: null, POST: null, ASSIGNED_BY_ID: "147", PHONE: [], EMAIL: [], UF_CRM_HHAPPLICANTID: null },
    { ID: "7002", NAME: "Соискатель", LAST_NAME: "Резюмов", POST: null, ASSIGNED_BY_ID: "205", PHONE: [{ VALUE: "87770000000" }], EMAIL: [], UF_CRM_HHAPPLICANTID: "hh-123" }
  ];
  const BY_ID = [{ ID: "15081", NAME: "Коммунальное", LAST_NAME: "государственное учреждение", POST: null, ASSIGNED_BY_ID: "559", PHONE: [], EMAIL: [{ VALUE: "shynbolat@mail.ru" }], UF_CRM_HHAPPLICANTID: null }];
  const ACTIVITIES = (body: Record<string, unknown>) => {
    const filter = body.filter as Record<string, unknown>;
    return filter.OWNER_TYPE_ID === 2
      ? [
          { ID: "9", SUBJECT: "Исходящий на 8 (775) 069 9265", DIRECTION: "2", COMPLETED: "Y", START_TIME: "2026-10-14T10:19:37+03:00", RESPONSIBLE_ID: "2345", OWNER_ID: "48519" },
          { ID: "5", SUBJECT: "Входящий от +7 702 588 4414", DIRECTION: "1", COMPLETED: "Y", START_TIME: "2026-10-01T09:00:00+03:00", RESPONSIBLE_ID: "725", OWNER_ID: "48519" }
        ]
      : [{ ID: "7", SUBJECT: "Исходящий на 8 (7172) 62 06 67", DIRECTION: "2", COMPLETED: "Y", START_TIME: "2026-10-10T12:00:00+03:00", RESPONSIBLE_ID: "559", OWNER_ID: "7001" }];
  };
  const mocks = () => ({
    "crm.company.list": [COMPANY],
    "crm.deal.list": DEALS,
    "crm.contact.list": (body: Record<string, unknown>) => ((body.filter as Record<string, unknown>).COMPANY_ID ? BY_COMPANY : BY_ID),
    "crm.activity.list": ACTIVITIES,
    "crm.status.list": [{ STATUS_ID: "C41:NEW", NAME: "Новая" }, { STATUS_ID: "C9:WON", NAME: "Сделка успешна" }]
  });

  it("finds the company by either origin id format and reads its deals", async () => {
    const { crm, calls } = reader(mocks(), { "crm.deal.list": 3 });

    const result = await crm.customerInCrm({ bin: "040340008429" });

    expect(calls[0]).toMatchObject({ method: "crm.company.list", body: { filter: { ORIGIN_ID: ["gz-company:040340008429", "040340008429"] } } });
    expect(result?.companies).toEqual([{ id: 10873, title: 'Акционерное общество "Жасыл даму"', bin: "040340008429", phones: ["87012227470"], emails: ["info@zhasyldamu.kz"] }]);
    expect(result?.deals).toMatchObject({ total: 3, won: 1, lost: 1, open: 1 });
    expect(result?.deals.recent[0]).toEqual({ id: 48519, title: "[GZ 88181580] Жасыл даму - Ноутбук", stage: "Новая", outcome: "open", amount: 3950000, assignedById: 725, created: "2026-10-13" });
    expect(calls.find((call) => call.method === "crm.deal.list" && (call.body.filter as Record<string, unknown>).COMPANY_ID)?.body).toMatchObject({ filter: { COMPANY_ID: [10873] } });
  });

  it("gathers the contacts of the company and of its deals, once each, without job applicants and empty placeholders", async () => {
    const { crm, calls } = reader(mocks());

    const result = await crm.customerInCrm({ bin: "040340008429" });

    expect(result?.contacts.map((contact) => contact.id)).toEqual([7001, 15081]);
    expect(result?.contacts[0]).toEqual({ id: 7001, name: "Наурызбаев Айбек Динмухамедович", post: "Руководитель службы закупок", phones: ["87011112233"], emails: ["a@zd.kz"], assignedById: 205 });
    // В этом Bitrix фамилия лежит в NAME, имя в LAST_NAME, отчество в SECOND_NAME; пустой «Гз» без телефона и почты не нужен.
    expect(JSON.stringify(result?.contacts)).not.toContain("Резюмов");
    expect(JSON.stringify(result?.contacts)).not.toContain("Гз");
    expect(result?.contacts[1].name).toBe("Коммунальное государственное учреждение");
    expect(calls.filter((call) => call.method === "crm.contact.list").map((call) => (call.body.filter as Record<string, unknown>).COMPANY_ID ?? (call.body.filter as Record<string, unknown>).ID)).toEqual([[10873], [15081]]);
  });

  it("lists the calls of the deals and contacts, newest first, with the time in Almaty", async () => {
    const { crm, calls } = reader(mocks());

    const result = await crm.customerInCrm({ bin: "040340008429" });

    expect(result?.calls).toEqual([
      { date: "2026-10-14 12:19", direction: "out", subject: "Исходящий на 8 (775) 069 9265", responsibleId: 2345, dealId: 48519 },
      { date: "2026-10-10 14:00", direction: "out", subject: "Исходящий на 8 (7172) 62 06 67", responsibleId: 559, dealId: null },
      { date: "2026-10-01 11:00", direction: "in", subject: "Входящий от +7 702 588 4414", responsibleId: 725, dealId: 48519 }
    ]);
    const activityCalls = calls.filter((call) => call.method === "crm.activity.list").map((call) => call.body.filter);
    expect(activityCalls).toEqual([
      { OWNER_TYPE_ID: 2, OWNER_ID: [48519, 47000, 46000], TYPE_ID: 2 },
      { OWNER_TYPE_ID: 3, OWNER_ID: [7001, 15081], TYPE_ID: 2 }
    ]);
  });

  it("returns null when the CRM has no company with this BIN anywhere", async () => {
    const { crm, calls } = reader({ ...mocks(), "crm.company.list": [], "crm.deal.list": [] });

    expect(await crm.customerInCrm({ bin: "040340008429" })).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(["crm.company.list", "crm.company.list", "crm.deal.list"]);
  });

  it("also finds companies whose BIN is only written in their comment or in the comment of their deals, once each", async () => {
    // Старые компании и компании из пунктов плана заведены без БИН в ORIGIN_ID: он остался в комментариях «BIN: <БИН>».
    const byComment = { ID: "7087", TITLE: 'НАО "КУ им. Ш.Уалиханова"', ORIGIN_ID: "gz-plan:4797676", PHONE: [], EMAIL: [] };
    const viaDeal = { ID: "7090", TITLE: "Школа без БИН", ORIGIN_ID: null, PHONE: [], EMAIL: [] };
    const { crm, calls } = reader({
      ...mocks(),
      "crm.company.list": (body: Record<string, unknown>) => {
        const filter = body.filter as Record<string, unknown>;
        if (filter.ORIGIN_ID) return [COMPANY];
        if (filter["%COMMENTS"]) return [byComment, COMPANY];
        return [viaDeal];
      },
      "crm.deal.list": (body: Record<string, unknown>) => ((body.filter as Record<string, unknown>)["%COMMENTS"] ? [{ ID: "1", COMPANY_ID: "7090" }, { ID: "2", COMPANY_ID: "10873" }] : DEALS)
    });

    const result = await crm.customerInCrm({ bin: "040340008429" });

    expect(result?.companies.map((company) => company.id)).toEqual([10873, 7087, 7090]);
    expect(calls[1].body).toMatchObject({ filter: { "%COMMENTS": "BIN: 040340008429" } });
    expect(calls[2]).toMatchObject({ method: "crm.deal.list", body: { filter: { "%COMMENTS": "BIN: 040340008429" } } });
    expect(calls[3]).toMatchObject({ method: "crm.company.list", body: { filter: { ID: [7090] } } });
  });

  it("adds the companies named by id next to the one found by BIN, once each (duplicate cards of the same customer)", async () => {
    const twin = { ID: "10659", TITLE: 'Коммунальное государственное учреждение "Средняя школа №297"', ORIGIN_ID: null, PHONE: [], EMAIL: [] };
    const { crm, calls } = reader({
      ...mocks(),
      "crm.company.list": (body: Record<string, unknown>) => {
        const filter = body.filter as Record<string, unknown>;
        return filter.ID ? [twin] : filter.ORIGIN_ID ? [COMPANY] : [];
      }
    });

    const result = await crm.customerInCrm({ bin: "040340008429", alsoCompanyIds: [10659, 10873] });

    expect(result?.companies.map((company) => company.id)).toEqual([10873, 10659]);
    expect(calls.find((call) => call.method === "crm.deal.list" && (call.body.filter as Record<string, unknown>).COMPANY_ID)?.body).toMatchObject({ filter: { COMPANY_ID: [10873, 10659] } });
  });

  it("takes a company id directly when the CRM company has no BIN", async () => {
    const { crm, calls } = reader({ ...mocks(), "crm.company.get": COMPANY });

    const result = await crm.customerInCrm({ companyId: 10873 });

    expect(calls[0]).toMatchObject({ method: "crm.company.get", body: { id: 10873 } });
    expect(result?.companies[0].id).toBe(10873);
  });

  it("keeps the answer when the calls cannot be read", async () => {
    const { crm } = reader({ ...mocks(), "crm.activity.list": () => { throw new Error("boom"); } });

    const result = await crm.customerInCrm({ bin: "040340008429" });

    expect(result?.contacts).toHaveLength(2);
    expect(result?.calls).toEqual([]);
  });
});
