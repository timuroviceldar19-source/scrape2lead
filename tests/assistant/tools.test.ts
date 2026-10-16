import { describe, expect, it } from "vitest";
import type { LotInfo } from "../../src/assistant/goszakupApi.js";
import { buildTools, type ToolDeps } from "../../src/assistant/tools.js";

const lot = (over: Partial<LotInfo> = {}): LotInfo => ({
  lotNumber: "83132229-ЗЦП1",
  name: "Компьютер",
  description: "специализированный",
  customerBin: "220640048477",
  customerName: 'ГУ "Аппарат акима области Ұлытау"',
  pointIds: [88224537],
  plans: [{ id: 88224537, name: "Компьютер", year: 2026, month: "Октябрь", status: "Опубликован", tradeMethod: "Запрос ценовых предложений", amount: 675274, count: 1, unitPrice: 675274, enstruCode: "262011.100.000001" }],
  lotStatus: "Опубликован (прием ценовых предложений)",
  amount: 675273.92,
  count: 1,
  announceId: 17771096,
  announceNumber: "17771096-1",
  buyStatus: "Опубликовано (прием ценовых предложений)",
  applicationsFrom: "2026-10-13 15:35",
  applicationsUntil: "2026-10-15 15:35",
  specFiles: [{ name: "techspec.pdf", url: "https://ows.goszakup.gov.kz/download/trd_buy/z" }],
  otherFiles: [],
  ...over
});

const deps = (over: Partial<ToolDeps> = {}): ToolDeps => ({
  crm: {
    getDealSummary: async (id) => ({ id, title: "[GZ 1] Заказчик", stageId: "C41:NEW", stage: "Новая", assignedById: 2301, amount: 100, companyId: 1, company: { id: 1, title: 'АО "Центр электронных финансов"', bin: "071140005693" }, originId: "gz-plan:1", kind: "plan", fields: [{ label: "БИН заказчика", value: "120540004946" }] }),
    findDeals: async () => ({ total: 1, deals: [{ id: 5, title: "[GZ лот 1-ЗЦП1] Заказчик" }] }),
    findCompanies: async () => [],
    customerInCrm: async () => null,
    listMyDeals: async () => ({
      total: 1222,
      deals: [
        { id: 48667, title: "[GZ лот 83132229-ЗЦП1] ГУ Аппарат акима - Компьютер", stage: "Новая", amount: 675273.92, kind: "lot", lotNumber: "83132229-ЗЦП1", modified: "2026-10-13" },
        { id: 40361, title: "№87246066 - Виртуализация", stage: "Сортировка", amount: null, kind: "other", lotNumber: null, modified: "2026-07-02" }
      ]
    })
  },
  goszakup: {
    customerCard: async (bin) => ({ bin, name: "КГУ Отдел образования", email: "a@example.kz", phone: "87262434486", website: null, parentOrg: null, administrators: [], extraPhones: [], head: null }),
    commissionMembers: async () => ({ tendersChecked: 0, tendersWithCommission: 0, members: [] }),
    findCustomers: async () => [{ bin: "1", name: "Школа", email: null, phone: null, website: null, parentOrg: null, administrators: [], extraPhones: [], head: null }],
    contractContacts: async () => ({
      totalContracts: 664,
      contacts: [{ fullName: "Оразалиев Канат Темирбекович", phones: ["87293223410", "87772064714"], contracts: 50, lastSignDate: "2026-10-08" }]
    }),
    contractPrices: async () => ({
      totalContracts: 168,
      prices: [
        { contractId: 1, signDate: "2026-10-13", customerBin: "1", customerName: "КГУ Школа", supplierBin: "2", supplierName: 'ТОО "F3.kz"', unitPrice: 427000, unitPriceNoVat: 427000, quantity: 130 },
        { contractId: 2, signDate: "2026-10-12", customerBin: "3", customerName: "Акимат", supplierBin: "4", supplierName: "ТОО Альфа", unitPrice: 335000, unitPriceNoVat: 335000, quantity: 10 },
        { contractId: 3, signDate: "2026-10-01", customerBin: "5", customerName: "Больница", supplierBin: "6", supplierName: "ТОО Бета", unitPrice: 1438000, unitPriceNoVat: 1438000, quantity: 1 }
      ]
    }),
    enstruCodes: async () => ({ totalPoints: 2045, codes: [{ code: "262011.100.000001", points: 72 }, { code: "262011.100.000002", points: 44 }] }),
    customerSuppliers: async () => ({
      totalContracts: 1157,
      analyzed: 200,
      suppliers: [
        { bin: "111111111111", name: 'ТОО "FutureProof"', contracts: 3, totalSum: 103_320_000, lastSignDate: "2026-10-08", subjects: ["Открытый конкурс", "Лицензии"] },
        { bin: "222222222222", name: "ТОО Бета", contracts: 1, totalSum: 500_000, lastSignDate: "2026-09-01", subjects: ["Почта"] }
      ]
    }),
    customerHistory: async () => ({
      totalContracts: 486,
      contracts: [{ id: 3, signDate: "2026-08-05", sum: 1292989.65, title: "Бензин", supplierBin: "111", supplierName: "ТОО А" }],
      topSuppliers: [{ bin: "111", name: "ТОО А", contracts: 4 }]
    }),
    lotInfo: async (lotNumber) => lot({ lotNumber }),
    lotsInfo: async (lotNumbers) => lotNumbers.map((lotNumber) => lot({ lotNumber })),
    lotDeadlines: async (lotNumbers) => lotNumbers.map((lotNumber) => lot({ lotNumber })),
    planStatus: async (planId) => ({
      plan: { id: planId, name: "Бумага", year: 2026, month: "Сентябрь", status: "Опубликован", tradeMethod: "Запрос ценовых предложений", amount: 20000, count: 20, unitPrice: 1000, enstruCode: "172211.200.000000" },
      lots: [
        { lotNumber: "88029122-ОИ4", lotStatus: "Опубликован (прием заявок)", amount: 20000, count: 20, announceId: 17773013, announceNumber: "17773013-1", buyStatus: "Опубликовано (прием заявок)", applicationsFrom: "2026-10-13 17:01", applicationsUntil: "2026-10-15 17:01", specFiles: [{ name: "techspec.pdf", url: "https://ows.goszakup.gov.kz/download/trd_buy/b" }], otherFiles: ["Перечень лотов"] },
        { lotNumber: "88029122-ЗЦП3", lotStatus: "Закупка не состоялась", amount: 20000, count: 20, announceId: 17744644, announceNumber: "17744644-1", buyStatus: "Завершено", applicationsFrom: "2026-10-09 17:00", applicationsUntil: "2026-10-13 17:00", specFiles: [], otherFiles: [] }
      ]
    }),
    recentTenders: async () => [{ announceId: 7, number: "7-1", publishDate: "2026-10-13", title: "x", totalSum: 1, specFiles: [{ name: "spec.pdf", url: "https://ows.goszakup.gov.kz/files/2" }], otherFiles: 0 }]
  },
  portal: {
    fetchAnnouncementContacts: async (announceId) => ({ announceId, customer: null, representative: { fullName: "ИВАНОВ И.", position: "Эксперт", email: "z@example.kz" } }),
    loadSpecFile: async () => ({ kind: "docx", text: "Контакт: Иванов, тел. 111" })
  },
  extractFromPdf: async () => "Контакт из PDF: Петров",
  ...over
});

const byName = (tools: ReturnType<typeof buildTools>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

describe("buildTools", () => {
  it("exposes the read-only tool set with schemas the model can use", () => {
    const tools = buildTools(deps());

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "announcement_contacts",
        "commission_members",
        "contract_contacts",
        "customer_card",
        "customer_in_crm",
        "customer_history",
        "customer_suppliers",
        "enstru_codes",
        "find_customer",
        "find_deals",
        "get_deal",
        "lot_info",
        "my_deals",
        "plan_status",
        "price_benchmark",
        "read_spec",
        "recent_tenders"
      ].sort()
    );
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input_schema.type).toBe("object");
    }
  });

  it("get_deal names the customer company with its BIN so the next step can use customer_card", async () => {
    const text = await byName(buildTools(deps()), "get_deal").run({ deal_id: 40361 });

    expect(text).toContain('АО "Центр электронных финансов"');
    expect(text).toContain("071140005693");
  });

  it("get_deal says when the company has no BIN in the CRM", async () => {
    const base = deps();
    const text = await byName(
      buildTools({ ...base, crm: { ...base.crm, getDealSummary: async (id) => ({ ...(await base.crm.getDealSummary(id)), company: { id: 1, title: "ТОО Ромашка", bin: null } }) } }),
      "get_deal"
    ).run({ deal_id: 1 });

    expect(text).toContain("ТОО Ромашка");
    expect(text).toMatch(/БИН[^\n]*не указан/);
  });

  it("get_deal returns the labeled fields as text", async () => {
    const text = await byName(buildTools(deps()), "get_deal").run({ deal_id: 48311 });

    expect(text).toContain("БИН заказчика");
    expect(text).toContain("120540004946");
  });

  it("rejects a bad deal id before calling Bitrix", async () => {
    await expect(byName(buildTools(deps()), "get_deal").run({ deal_id: "abc" })).rejects.toThrow(/deal_id/);
  });

  it("customer_card returns the registry contacts", async () => {
    const text = await byName(buildTools(deps()), "customer_card").run({ bin: "120540004946" });

    expect(text).toContain("a@example.kz");
    expect(text).toContain("87262434486");
  });

  it("customer_card names who the customer reports to and says plainly when the registry has no such data", async () => {
    const withParents: ToolDeps = {
      ...deps(),
      goszakup: {
        ...deps().goszakup,
        customerCard: async (bin) => ({
          bin,
          name: 'АО "Жасыл даму"',
          email: null,
          phone: null,
          website: null,
          parentOrg: "Управление экологии",
          administrators: [{ bin: "140940023346", name: 'ГУ "Министерство энергетики Республики Казахстан"', budget: "Республиканский бюджет", since: "2018-09-07" }],
          extraPhones: ["79-79-41", "27-80-30"],
          head: "СӘРСЕНБАЙ ЕРЖАН НҰРЛАНҰЛЫ"
        })
      }
    };

    const text = await byName(buildTools(withParents), "customer_card").run({ bin: "040340008429" });
    const plain = await byName(buildTools(deps()), "customer_card").run({ bin: "120540004946" });

    expect(text).toContain("вышестоящая организация: Управление экологии");
    expect(text).toContain('администратор бюджета: ГУ "Министерство энергетики Республики Казахстан", БИН 140940023346 (Республиканский бюджет, запись с 2018-09-07)');
    expect(text).toContain("другие телефоны из адресов: 79-79-41; 27-80-30");
    expect(text).toContain("руководитель по кабинету организации на портале: Сәрсенбай Ержан Нұрланұлы");
    expect(plain).toContain("вышестоящая организация: в реестре не указана");
    expect(plain).not.toContain("администратор бюджета");
    expect(plain).not.toContain("другие телефоны");
    expect(plain).not.toContain("руководитель по кабинету");
  });

  it("customer_card validates the BIN", async () => {
    await expect(byName(buildTools(deps()), "customer_card").run({ bin: "12" })).rejects.toThrow(/БИН|bin/i);
  });

  it("recent_tenders lists announcements with spec file links", async () => {
    const text = await byName(buildTools(deps()), "recent_tenders").run({ bin: "120540004946", limit: 3 });

    expect(text).toContain("7-1");
    expect(text).toContain("https://ows.goszakup.gov.kz/files/2");
  });

  it("announcement_contacts returns the representative", async () => {
    const text = await byName(buildTools(deps()), "announcement_contacts").run({ announce_id: 7 });

    expect(text).toContain("Иванов И.");
    expect(text).toContain("z@example.kz");
  });

  it("read_spec returns Word text directly", async () => {
    const text = await byName(buildTools(deps()), "read_spec").run({ url: "https://ows.goszakup.gov.kz/files/1" });

    expect(text).toContain("Контакт: Иванов");
  });

  it("read_spec sends a PDF through the extractor", async () => {
    const tools = buildTools(deps({ portal: { ...deps().portal, loadSpecFile: async () => ({ kind: "pdf", base64: "QQ==", bytes: 1 }) } }));

    const text = await byName(tools, "read_spec").run({ url: "https://ows.goszakup.gov.kz/files/2" });

    expect(text).toContain("Контакт из PDF: Петров");
  });

  it("read_spec says plainly when the format is not supported", async () => {
    const tools = buildTools(deps({ portal: { ...deps().portal, loadSpecFile: async () => ({ kind: "unsupported", note: "формат .xls" }) } }));

    const text = await byName(tools, "read_spec").run({ url: "https://ows.goszakup.gov.kz/files/3" });

    expect(text).toMatch(/не поддерж|не удалось прочитать/i);
  });
});

describe("contacts from contracts", () => {
  it("contract_contacts lists the customer's representative with the phones from the contracts", async () => {
    const text = await byName(buildTools(deps()), "contract_contacts").run({ bin: "970340001366" });

    expect(text).toContain("Оразалиев Канат Темирбекович");
    expect(text).toContain("87293223410");
    expect(text).toContain("87772064714");
    expect(text).toContain("664");
  });

  it("contract_contacts says plainly when the customer has no contracts", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, contractContacts: async () => ({ totalContracts: 0, contacts: [] }) } });

    expect(await byName(tools, "contract_contacts").run({ bin: "970340001366" })).toMatch(/не нашлось|нет договоров/i);
  });
});

describe("price_benchmark", () => {
  const now = () => new Date("2026-10-13T08:00:00Z");

  it("summarizes unit prices and shows who bought and who won", async () => {
    const text = await byName(buildTools(deps(), { now }), "price_benchmark").run({ enstru_code: "262011.100.000001" });

    expect(text).toMatch(/с НДС/);
    expect(text).toContain("335 000"); // минимум
    expect(text).toContain("427 000"); // медиана
    expect(text).toContain("1 438 000"); // максимум
    expect(text).toContain('ТОО "F3.kz"');
    expect(text).toContain("КГУ Школа");
    expect(text).toContain("168");
  });

  it("asks for the current year by default and for another year on request", async () => {
    const years: number[] = [];
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, contractPrices: async ({ year }) => (years.push(year), { totalContracts: 0, prices: [] }) } }, { now });

    await byName(tools, "price_benchmark").run({ enstru_code: "262011.100.000001" });
    await byName(tools, "price_benchmark").run({ enstru_code: "262011.100.000001", year: 2025 });

    expect(years).toEqual([2026, 2025]);
  });

  it("says so when there are no contracts for the code", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, contractPrices: async () => ({ totalContracts: 0, prices: [] }) } }, { now });

    expect(await byName(tools, "price_benchmark").run({ enstru_code: "262011.100.000001" })).toMatch(/не найдено|нет договоров/i);
  });

  it("rejects something that is not an ENSTRU code", async () => {
    await expect(byName(buildTools(deps(), { now }), "price_benchmark").run({ enstru_code: "ноутбук" })).rejects.toThrow(/ЕНС ТРУ|enstru/i);
  });
});

describe("customer_history", () => {
  it("shows the total, the latest contracts and the most frequent winners", async () => {
    const text = await byName(buildTools(deps()), "customer_history").run({ bin: "950340001114" });

    expect(text).toContain("486");
    expect(text).toContain("Бензин");
    expect(text).toContain("ТОО А");
    expect(text).toContain("4");
  });

  it("passes the ENSTRU code to narrow the history", async () => {
    let seen: unknown;
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, customerHistory: async (_bin, options) => ((seen = options), { totalContracts: 0, contracts: [], topSuppliers: [] }) } });

    await byName(tools, "customer_history").run({ bin: "950340001114", enstru_code: "262011.100.000001" });

    expect(seen).toMatchObject({ enstruCode: "262011.100.000001" });
  });
});

describe("plan_status", () => {
  it("shows the plan point, every announced tender with its bid period and the spec link", async () => {
    const text = await byName(buildTools(deps()), "plan_status").run({ plan_id: 88029122 });

    expect(text).toContain("Опубликован");
    expect(text).toContain("17773013-1");
    expect(text).toContain("2026-10-13 17:01");
    expect(text).toContain("2026-10-15 17:01");
    expect(text).toContain("Закупка не состоялась");
    expect(text).toContain("https://ows.goszakup.gov.kz/download/trd_buy/b");
  });

  it("refuses a lot number: its prefix can be an old plan point, so the lot must be read with lot_info", async () => {
    await expect(byName(buildTools(deps()), "plan_status").run({ plan_id: "88029122-ЗЦП1" })).rejects.toThrow(/lot_info/);
  });

  it("accepts the plan point number written as text", async () => {
    let asked = 0;
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, planStatus: async (id) => ((asked = id), { plan: null, lots: [] }) } });

    await byName(tools, "plan_status").run({ plan_id: " 88029122 " });

    expect(asked).toBe(88029122);
  });

  it("says that no tender has been announced yet for a plan point", async () => {
    const base = deps();
    const full = await base.goszakup.planStatus(1);
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, planStatus: async () => ({ plan: full.plan, lots: [] }) } });

    expect(await byName(tools, "plan_status").run({ plan_id: 1 })).toMatch(/пока не объявлен|ещё не объявлен/i);
  });

  it("tells that the customer amended the plan point and which code is current", async () => {
    const base = deps();
    const full = await base.goszakup.planStatus(1);
    const amended = { ...full.plan!, id: 88294659, name: "Панель жидкокристаллическая", enstruCode: "279020.100.000002", revisedAt: "2026-10-15" };
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, planStatus: async () => ({ plan: amended, lots: [] }) } });

    const text = await byName(tools, "plan_status").run({ plan_id: 88137237 });

    expect(text).toContain("Пункт плана 88137237");
    expect(text).toContain("изменён заказчиком 2026-10-15");
    expect(text).toContain("код ЕНС ТРУ 279020.100.000002");
    expect(text).toMatch(/код и название.*сделке.*устар/i);
  });

  it("says when the plan point is unknown", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, planStatus: async () => ({ plan: null, lots: [] }) } });

    expect(await byName(tools, "plan_status").run({ plan_id: 1 })).toMatch(/не найден/i);
  });
});

describe("lot_info", () => {
  it("gives the customer BIN, the real bid period and the current plan point of a lot", async () => {
    const text = await byName(buildTools(deps()), "lot_info").run({ lot_number: "83132229-ЗЦП1" });

    expect(text).toContain("220640048477");
    expect(text).toContain('ГУ "Аппарат акима области Ұлытау"');
    expect(text).toContain("2026-10-15 15:35");
    expect(text).toContain("Опубликован (прием ценовых предложений)");
    expect(text).toContain("88224537");
    expect(text).toContain("262011.100.000001");
    expect(text).toContain("https://ows.goszakup.gov.kz/download/trd_buy/z");
  });

  it("says when the lot is not in the registry", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, lotInfo: async () => null } });

    expect(await byName(tools, "lot_info").run({ lot_number: "1-ЗЦП1" })).toMatch(/не найден/i);
  });
});

describe("my_deals", () => {
  const now = () => new Date("2026-10-13T08:00:00Z"); // 13:00 в Алматы
  const dealRow = (id: number, lotNumber: string | null) => ({ id, title: `[GZ лот ${lotNumber}] Заказчик ${id}`, stage: "Новая", amount: 100000 + id, kind: lotNumber ? ("lot" as const) : ("other" as const), lotNumber, modified: "2026-10-13" });
  const registry: Record<string, LotInfo | null> = {
    "A-1": lot({ lotNumber: "A-1", applicationsUntil: "2026-10-15 15:35" }),
    "B-1": lot({ lotNumber: "B-1", lotStatus: "Закупка не состоялась", buyStatus: "Завершено", applicationsUntil: "2026-10-07 17:05" }),
    "C-1": lot({ lotNumber: "C-1", applicationsUntil: "2026-10-14 10:00" }),
    "D-1": lot({ lotNumber: "D-1", applicationsUntil: "2026-10-13 12:00" }), // уже закончилась в Алматы
    "E-1": null
  };
  const withDeals = (rows: ReturnType<typeof dealRow>[], seen: unknown[] = []) => {
    const base = deps();
    return buildTools(
      {
        ...base,
        crm: { ...base.crm, listMyDeals: async (request) => (seen.push(request), { total: 1222, deals: rows }) },
        goszakup: {
          ...base.goszakup,
          lotsInfo: async (numbers) => numbers.map((n) => registry[n] ?? null),
          lotDeadlines: async (numbers) => numbers.map((n) => registry[n] ?? null)
        }
      },
      { userId: 2301, now }
    );
  };
  const rows = [dealRow(1, "A-1"), dealRow(2, "B-1"), dealRow(3, "C-1"), dealRow(4, "D-1"), dealRow(5, "E-1")];

  it("shows only tenders that are still accepting bids, by the real end time from the registry, nearest first", async () => {
    const text = await byName(withDeals(rows), "my_deals").run({});

    expect(text.indexOf("#3")).toBeGreaterThan(-1);
    expect(text.indexOf("#3")).toBeLessThan(text.indexOf("#1"));
    expect(text).toContain("2026-10-14 10:00");
    expect(text).toContain("через 1 дн.");
    expect(text).toContain("2026-10-15 15:35");
    expect(text).not.toContain("#2"); // закупка не состоялась
    expect(text).not.toContain("#4"); // срок вышел
    expect(text).toContain("1222");
  });

  it("admits that some lots could not be checked instead of hiding them", async () => {
    const text = await byName(withDeals(rows), "my_deals").run({});

    expect(text).toMatch(/не удалось проверить: 1/);
  });

  it("scans every open lot deal of the asking manager, not only the newest ones", async () => {
    const seen: unknown[] = [];

    const text = await byName(withDeals(rows, seen), "my_deals").run({});

    expect(seen).toEqual([{ userId: 2301, scope: "lots", order: "newest", limit: 2000 }]);
    expect(text).toContain("Проверено в реестре 5 открытых лотов");
  });

  it("finds a live tender that sits far down the list of old deals", async () => {
    const old = Array.from({ length: 149 }, (_, i) => dealRow(1000 + i, "B-1"));
    const text = await byName(withDeals([...old, dealRow(7, "A-1")]), "my_deals").run({});

    expect(text).toContain("#7");
    expect(text).toContain("Приём заявок ещё идёт у 1");
  });

  it("says how many live tenders there are when it shows only the nearest ones", async () => {
    const many = Array.from({ length: 12 }, (_, i) => dealRow(2000 + i, "A-1"));
    const text = await byName(withDeals(many), "my_deals").run({});

    expect(text).toContain("показаны ближайшие 10 из 12");
    expect((text.match(/#20\d\d/g) ?? []).length).toBe(10);
  });

  it("recent mode lists the latest deals with the tender status from the registry for lots", async () => {
    const seen: unknown[] = [];
    const text = await byName(withDeals([dealRow(2, "B-1"), dealRow(9, null)], seen), "my_deals").run({ sort: "recent", limit: 50 });

    expect(seen).toEqual([{ userId: 2301, scope: "all", order: "recent", limit: 20 }]);
    expect(text).toContain("#2");
    expect(text).toContain("Закупка не состоялась");
    expect(text).toContain("#9");
  });

  it("does not guess whose deals to show when the asker is unknown", async () => {
    await expect(byName(buildTools(deps()), "my_deals").run({})).rejects.toThrow(/кто спрашивает|чьи сделки/i);
  });

  it("compares with the clock in Almaty, not UTC", async () => {
    const base = deps();
    const tools = buildTools(
      { ...base, crm: { ...base.crm, listMyDeals: async () => ({ total: 1, deals: [dealRow(3, "C-1")] }) }, goszakup: { ...base.goszakup, lotDeadlines: async () => [registry["C-1"]] } },
      { userId: 1, now: () => new Date("2026-10-14T05:30:00Z") } // 10:30 в Алматы: срок 10:00 уже прошёл
    );

    expect(await byName(tools, "my_deals").run({})).not.toContain("#3");
  });
});

describe("customer_in_crm", () => {
  const history = {
    companies: [{ id: 10873, title: 'Акционерное общество "Жасыл даму"', bin: "040340008429", phones: ["87012227470"], emails: ["info@zhasyldamu.kz"] }],
    contacts: [{ id: 7001, name: "Наурызбаев Айбек Динмухамедович", post: "Руководитель службы закупок", phones: ["87011112233"], emails: ["a@zd.kz"], assignedById: 205 }],
    deals: {
      total: 3,
      won: 1,
      lost: 1,
      open: 1,
      recent: [
        { id: 48519, title: "[GZ 88181580] Жасыл даму - Ноутбук", stage: "Новая", outcome: "open" as const, amount: 3950000, assignedById: 725, created: "2026-10-13" },
        { id: 47000, title: "Старая закупка - Монитор", stage: "Сделка успешна", outcome: "won" as const, amount: 1200000, assignedById: 205, created: "2026-05-02" }
      ]
    },
    calls: [
      { date: "2026-10-14 12:19", direction: "out" as const, subject: "Исходящий на 8 (775) 069 9265", responsibleId: 2345, dealId: 48519 },
      { date: "2026-10-01 11:00", direction: "in" as const, subject: "Входящий от +7 702 588 4414", responsibleId: 205, dealId: null }
    ]
  };
  const withHistory = (value: typeof history | null, asked: unknown[] = []) => {
    const base = deps();
    return buildTools({ ...base, crm: { ...base.crm, customerInCrm: async (target) => (asked.push(target), value) } }, { userId: 205 });
  };

  it("tells what our CRM already holds: contacts with phones, past deals with their outcome, and calls", async () => {
    const asked: unknown[] = [];
    const text = await byName(withHistory(history, asked), "customer_in_crm").run({ bin: "040340008429" });

    expect(asked).toEqual([{ bin: "040340008429" }]);
    expect(text).toContain('Акционерное общество "Жасыл даму" (компания в Bitrix 10873)');
    expect(text).toContain("Наурызбаев Айбек Динмухамедович, Руководитель службы закупок, тел. 87011112233, e-mail a@zd.kz, ответственный: вы");
    expect(text).toContain("Сделок с этим заказчиком: 3 (успешных 1, проваленных 1, в работе 1)");
    expect(text).toContain("#48519 [GZ 88181580] Жасыл даму - Ноутбук: Новая, в работе, ответственный: сотрудник с номером 725, создана 2026-10-13, сумма 3950000");
    expect(text).toContain("#47000 Старая закупка - Монитор: Сделка успешна, успешная, ответственный: вы");
    expect(text).toContain("2026-10-14 12:19 исходящий: Исходящий на 8 (775) 069 9265, звонил сотрудник с номером 2345 (сделка 48519)");
    expect(text).toContain("2026-10-01 11:00 входящий: Входящий от +7 702 588 4414, принимал вы");
  });

  it("says plainly when the customer is not in the CRM at all", async () => {
    const text = await byName(withHistory(null), "customer_in_crm").run({ bin: "040340008429" });

    expect(text).toMatch(/в Bitrix.*нет/i);
    expect(text).not.toContain("company_id"); // похожих компаний нет, предлагать нечего
  });

  it("attaches the CRM card of the same organization that was entered without a BIN, when its title matches the registry name", async () => {
    const base = deps();
    const asked: unknown[] = [];
    const tools = buildTools({
      ...base,
      goszakup: { ...base.goszakup, customerCard: async (bin) => ({ bin, name: 'КГУ «Средняя школа №297» отдела образования по городу Кызылорда', email: null, phone: null, website: null, parentOrg: null, administrators: [], extraPhones: [], head: null }) },
      crm: {
        ...base.crm,
        customerInCrm: async (target) => (asked.push(target), history),
        findCompanies: async () => [
          { id: 10659, title: 'Коммунальное государственное учреждение "Средняя школа №297" отдела образования по городу Кызылорда', bin: null },
          { id: 600, title: 'Коммунальное государственное учреждение "Средняя школа №297" отдела образования по городу Астана', bin: null },
          { id: 9299, title: 'КГУ "Средняя школа №297" отдела образования по городу Кызылорда', bin: "161040010123" }
        ]
      }
    });

    await byName(tools, "customer_in_crm").run({ bin: "161040010123" });

    // двойник без БИН с тем же полным названием присоединяется; другой город и компания с этим же БИН — нет
    expect(asked).toEqual([{ bin: "161040010123", alsoCompanyIds: [10659] }]);
  });

  it("offers the CRM companies with a similar name when none carries this BIN, so the model can pick by company id", async () => {
    const base = deps();
    const searched: string[] = [];
    const tools = buildTools({
      ...base,
      goszakup: { ...base.goszakup, customerCard: async (bin) => ({ bin, name: 'КГУ «Средняя школа №297» отдела образования по городу Кызылорда', email: null, phone: null, website: null, parentOrg: null, administrators: [], extraPhones: [], head: null }) },
      crm: {
        ...base.crm,
        customerInCrm: async () => null,
        findCompanies: async (name) => (searched.push(name), [{ id: 10659, title: 'Коммунальное государственное учреждение "Средняя школа №297"', bin: null }, { id: 555, title: 'Школа "Средняя школа №297" (другой город)', bin: "111111111111" }])
      }
    });

    const text = await byName(tools, "customer_in_crm").run({ bin: "161040010123" });

    expect(searched).toEqual(["Средняя школа №297"]);
    expect(text).toContain("Коммунальное государственное учреждение");
    expect(text).toContain("компания в Bitrix 10659, БИН в карточке не указан");
    expect(text).not.toContain("компания в Bitrix 555"); // у неё другой БИН, это не она
    expect(text).toContain("company_id");
  });

  it("says when the CRM has the company but no contacts and no calls", async () => {
    const text = await byName(withHistory({ ...history, contacts: [], calls: [], deals: { total: 0, won: 0, lost: 0, open: 0, recent: [] } }), "customer_in_crm").run({ bin: "040340008429" });

    expect(text).toContain("Контактов с телефоном или почтой в Bitrix нет");
    expect(text).toContain("Сделок с этим заказчиком нет");
    expect(text).toContain("Звонков по сделкам и контактам заказчика нет");
  });

  it("takes either a BIN or a company id and validates them", async () => {
    const asked: unknown[] = [];
    const tools = withHistory(history, asked);

    await byName(tools, "customer_in_crm").run({ company_id: 10873 });

    expect(asked).toEqual([{ companyId: 10873 }]);
    await expect(byName(tools, "customer_in_crm").run({})).rejects.toThrow(/bin|company_id|БИН/i);
    await expect(byName(tools, "customer_in_crm").run({ bin: "12" })).rejects.toThrow(/БИН/);
  });
});

describe("commission_members", () => {
  it("shows who decides on the customer's purchases, with roles, and says it is names only", async () => {
    const base = deps();
    const asked: string[] = [];
    const tools = buildTools({
      ...base,
      goszakup: {
        ...base.goszakup,
        commissionMembers: async (bin) => {
          asked.push(bin);
          return {
            tendersChecked: 10,
            tendersWithCommission: 4,
            members: [
              { fullName: "ДОСЫМБЕКОВ ДАНИЯР КОТТЫБЕКОВИЧ", roles: ["Председатель"], tenders: 4 },
              { fullName: "НАУРЫЗБАЕВ АЙБЕК ДИНМУХАМЕДОВИЧ", roles: ["Член комиссии"], tenders: 3 }
            ]
          };
        }
      }
    });

    const text = await byName(tools, "commission_members").run({ bin: "040340008429" });

    expect(asked).toEqual(["040340008429"]);
    expect(text).toContain("Проверено закупок: 10, комиссия указана в 4");
    expect(text).toContain("Досымбеков Данияр Коттыбекович: Председатель, в 4 закупках");
    expect(text).toContain("Наурызбаев Айбек Динмухамедович: Член комиссии, в 3 закупках");
    expect(text).toMatch(/только ФИО и роли/i);
  });

  it("does not pretend when the registry has no commission for the customer", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, commissionMembers: async () => ({ tendersChecked: 10, tendersWithCommission: 0, members: [] }) } });

    expect(await byName(tools, "commission_members").run({ bin: "040340008429" })).toMatch(/комиссия.*не указана|не указан/i);
  });

  it("validates the BIN", async () => {
    await expect(byName(buildTools(deps()), "commission_members").run({ bin: "12" })).rejects.toThrow(/БИН|bin/i);
  });
});

describe("find_customer", () => {
  it("falls back to the companies already in Bitrix when the registry knows no such exact name", async () => {
    const base = deps();
    const tools = buildTools({
      ...base,
      crm: { ...base.crm, findCompanies: async () => [{ id: 10873, title: 'Акционерное общество "Жасыл даму"', bin: "040340008429" }] },
      goszakup: { ...base.goszakup, findCustomers: async () => [] }
    });

    const text = await byName(tools, "find_customer").run({ name: "Жасыл даму" });

    expect(text).toContain("040340008429");
    expect(text).toContain("Жасыл даму");
    expect(text).toContain("Bitrix");
    // Поиск по названию в реестре точный: «не нашлось» не значит «в реестре нет». Организацию проверяют по БИН.
    expect(text).toMatch(/не значит.*нет в реестре/i);
    expect(text).toContain("customer_card");
  });

  it("does not look in Bitrix when the registry already answered", async () => {
    const base = deps();
    let asked = false;
    const tools = buildTools({ ...base, crm: { ...base.crm, findCompanies: async () => ((asked = true), []) } });

    await byName(tools, "find_customer").run({ name: "Школа" });

    expect(asked).toBe(false);
  });

  it("says so when neither the registry nor Bitrix knows the name", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, findCustomers: async () => [] } });

    expect(await byName(tools, "find_customer").run({ name: "Нет такой" })).toContain("не найдено");
  });
});

describe("customer_suppliers", () => {
  it("lists who supplies the customer, with counts, sums and the registry contacts of the leaders", async () => {
    const base = deps();
    const cards: Record<string, { email: string | null; phone: string | null }> = {
      "111111111111": { email: "info@futureproof.kz", phone: "87001112233" },
      "222222222222": { email: null, phone: null }
    };
    const tools = buildTools({
      ...base,
      goszakup: { ...base.goszakup, customerCard: async (bin) => ({ bin, name: "x", website: null, parentOrg: null, administrators: [], extraPhones: [], head: null, ...cards[bin] }) }
    });

    const text = await byName(tools, "customer_suppliers").run({ bin: "040340008429" });

    expect(text).toContain("200");
    expect(text).toContain("1157");
    expect(text).toContain('ТОО "FutureProof"');
    expect(text).toContain("111111111111");
    expect(text).toContain("договоров 3");
    expect(text).toMatch(/103[\s\u00a0]320[\s\u00a0]000/);
    expect(text).toContain("info@futureproof.kz");
    expect(text).toContain("87001112233");
    expect(text.indexOf("FutureProof")).toBeLessThan(text.indexOf("Бета"));
  });

  it("passes the ENSTRU code on and still answers when a supplier card cannot be read", async () => {
    const base = deps();
    let seen: { limit?: number; enstruCode?: string } | undefined;
    const tools = buildTools({
      ...base,
      goszakup: {
        ...base.goszakup,
        customerSuppliers: async (_bin, options) => ((seen = options), (await base.goszakup.customerSuppliers("x"))),
        customerCard: async () => {
          throw new Error("registry is down");
        }
      }
    });

    const text = await byName(tools, "customer_suppliers").run({ bin: "040340008429", enstru_code: "262011.100.000001" });

    expect(seen?.enstruCode).toBe("262011.100.000001");
    expect(text).toContain('ТОО "FutureProof"');
    expect(text).toContain("контакты не удалось прочитать");
  });

  it("says so when the customer has no contracts", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, customerSuppliers: async () => ({ totalContracts: 0, analyzed: 0, suppliers: [] }) } });

    expect(await byName(tools, "customer_suppliers").run({ bin: "040340008429" })).toContain("не найдено");
  });
});

describe("get_deal", () => {
  it("shows the stage by name and who is responsible, relative to the asker", async () => {
    const mine = await byName(buildTools(deps(), { userId: 2301 }), "get_deal").run({ deal_id: 1 });
    const other = await byName(buildTools(deps(), { userId: 1 }), "get_deal").run({ deal_id: 1 });

    expect(mine).toContain("стадия: Новая");
    expect(mine).not.toContain("C41:NEW");
    expect(mine).toMatch(/Ответственный: вы/);
    expect(other).toMatch(/Ответственный: сотрудник с номером 2301, не вы/);
  });

  it("says plainly when nobody is responsible", async () => {
    const base = deps();
    const tools = buildTools({ ...base, crm: { ...base.crm, getDealSummary: async (id) => ({ ...(await base.crm.getDealSummary(id)), assignedById: null }) } }, { userId: 1 });

    expect(await byName(tools, "get_deal").run({ deal_id: 1 })).toMatch(/Ответственный: не назначен/);
  });
});

describe("find_deals", () => {
  const found = (total: number, ids: number[]) => async () => ({ total, deals: ids.map((id) => ({ id, title: `Ноутбук ${id}` })) });

  it("says how many deals match when there are more than it shows", async () => {
    const base = deps();
    const tools = buildTools({ ...base, crm: { ...base.crm, findDeals: found(83, [1, 2, 3]) } });

    const text = await byName(tools, "find_deals").run({ query: "Ноутбук" });

    expect(text).toContain("Найдено сделок: 83");
    expect(text).toContain("показаны первые 3");
  });

  it("looks only at the asker's open deals with mine=true", async () => {
    const base = deps();
    let seen: unknown;
    const tools = buildTools({ ...base, crm: { ...base.crm, findDeals: async (q, options) => ((seen = options), { total: 2, deals: [{ id: 9, title: `${q} 9` }] }) } }, { userId: 2301 });

    const text = await byName(tools, "find_deals").run({ query: "Ноутбук", mine: true });

    expect(seen).toMatchObject({ userId: 2301 });
    expect(text).toContain("ваши открытые");
  });

  it("does not guess whose deals mine=true means when the asker is unknown", async () => {
    await expect(byName(buildTools(deps()), "find_deals").run({ query: "Ноутбук", mine: true })).rejects.toThrow(/кто спрашивает|чьи сделки/i);
  });
});

describe("contact names", () => {
  it("writes names the registry shouts in capitals as ordinary names, so the model has nothing to re-spell", async () => {
    const base = deps();
    const tools = buildTools({
      ...base,
      portal: { ...base.portal, fetchAnnouncementContacts: async (announceId) => ({ announceId, customer: null, representative: { fullName: "НАУРЫЗБАЕВ АЙБЕК ДИНМУХАМЕДОВИЧ", position: "Руководитель Службы закупок", email: "k@example.kz" } }) },
      goszakup: { ...base.goszakup, contractContacts: async () => ({ totalContracts: 1, contacts: [{ fullName: "ТУҒАНБАЙҰЛЫ НҰРХАН", phones: ["1"], contracts: 1, lastSignDate: "2026-10-08" }, { fullName: "Иванов Иван", phones: [], contracts: 1, lastSignDate: "2026-10-01" }, { fullName: "КУСАИНОВА-АХМЕТОВА АЙГУЛЬ", phones: [], contracts: 1, lastSignDate: "2026-09-01" }] }) }
    });

    const announcement = await byName(tools, "announcement_contacts").run({ announce_id: 1 });
    const contracts = await byName(tools, "contract_contacts").run({ bin: "970340001366" });

    expect(announcement).toContain("Наурызбаев Айбек Динмухамедович");
    expect(contracts).toContain("Туғанбайұлы Нұрхан");
    expect(contracts).toContain("Иванов Иван");
    expect(contracts).toContain("Кусаинова-Ахметова Айгуль");
  });
});

describe("lot_info time left", () => {
  const at = (iso: string) => ({ userId: 1, now: () => new Date(iso) });

  it("counts the time left to the end of bidding, in Almaty time", async () => {
    const days = await byName(buildTools(deps(), at("2026-10-14T05:00:00Z")), "lot_info").run({ lot_number: "83132229-ЗЦП1" }); // 10:00, срок 15.10 15:35
    const hours = await byName(buildTools({ ...deps(), goszakup: { ...deps().goszakup, lotInfo: async () => lot({ applicationsUntil: "2026-10-14 11:12" }) } }, at("2026-10-14T05:00:00Z")), "lot_info").run({ lot_number: "X" });

    expect(days).toContain("осталось 1 дн. 5 ч");
    expect(hours).toContain("осталось 1 ч 12 мин");
  });

  it("says the bidding is over instead of counting a negative time", async () => {
    const tools = buildTools({ ...deps(), goszakup: { ...deps().goszakup, lotInfo: async () => lot({ applicationsUntil: "2026-10-14 09:00" }) } }, at("2026-10-14T05:00:00Z"));

    expect(await byName(tools, "lot_info").run({ lot_number: "X" })).toContain("срок приёма заявок вышел");
  });
});

describe("enstru_codes", () => {
  it("shows the codes for a product name, most used first, and how to use them", async () => {
    const text = await byName(buildTools(deps(), { now: () => new Date("2026-10-14T05:00:00Z") }), "enstru_codes").run({ name: "Ноутбук" });

    expect(text).toContain("262011.100.000001");
    expect(text.indexOf("262011.100.000001")).toBeLessThan(text.indexOf("262011.100.000002"));
    expect(text).toContain("72");
    expect(text).toMatch(/price_benchmark/);
  });

  it("asks for the name of the product as plans write it when nothing is found", async () => {
    const base = deps();
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, enstruCodes: async () => ({ totalPoints: 0, codes: [] }) } });

    expect(await byName(tools, "enstru_codes").run({ name: "Компьютеры" })).toMatch(/не найден/);
  });

  it("uses this year in Almaty", async () => {
    const base = deps();
    let seen = 0;
    const tools = buildTools({ ...base, goszakup: { ...base.goszakup, enstruCodes: async (_name, year) => ((seen = year ?? 0), { totalPoints: 0, codes: [] }) } }, { now: () => new Date("2026-12-31T20:00:00Z") });

    await byName(tools, "enstru_codes").run({ name: "Ноутбук" });

    expect(seen).toBe(2027); // в Алматы уже 1 января
  });
});

