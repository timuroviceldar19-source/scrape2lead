import { describe, expect, it } from "vitest";
import { GoszakupApi } from "../../src/assistant/goszakupApi.js";

function api(data: Record<string, unknown>) {
  const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data, extensions: { pageInfo: { hasNextPage: false, lastId: 1 } } }), { status: 200 });
  }) as typeof fetch;
  return { goszakup: new GoszakupApi({ token: "t", fetchFn, retryDelayMs: 0 }), bodies };
}

describe("GoszakupApi.customerCard", () => {
  it("returns the organization contacts from the registry", async () => {
    const { goszakup, bodies } = api({
      Subjects: [{ bin: "120540004946", nameRu: "КГУ Отдел образования", email: "a@example.kz", phone: "87262434486", website: "" }]
    });

    expect(await goszakup.customerCard("120540004946")).toEqual({
      bin: "120540004946",
      name: "КГУ Отдел образования",
      email: "a@example.kz",
      phone: "87262434486",
      website: null,
      parentOrg: null,
      administrators: [],
      extraPhones: [],
      head: null
    });
    expect(bodies[0].variables).toMatchObject({ bin: "120540004946" });
  });

  it("names the parent organization and the budget administrator so a manager can see who the customer reports to", async () => {
    const { goszakup, bodies } = api({
      Subjects: [
        {
          bin: "040340008429",
          nameRu: 'АО "Жасыл даму"',
          email: "info@zhasyldamu.kz",
          phone: "",
          website: "",
          parentNameRu: " Управление экологии ",
          Admins: [
            { bin: "140940023346", nameRu: 'Государственное учреждение "Министерство энергетики Республики Казахстан"', budgetRu: "Республиканский бюджет", startDate: "2018-09-07 08:47:38" },
            { nameRu: "", budgetRu: "", startDate: "" }
          ]
        }
      ]
    });

    const card = await goszakup.customerCard("040340008429");

    expect(card).toMatchObject({
      parentOrg: "Управление экологии",
      administrators: [{ bin: "140940023346", name: 'Государственное учреждение "Министерство энергетики Республики Казахстан"', budget: "Республиканский бюджет", since: "2018-09-07" }]
    });
    expect(bodies[0].query).toMatch(/parentNameRu/);
    expect(bodies[0].query).toMatch(/Admins\s*\{[^}]*nameRu/);
  });

  it("returns null when the organization is unknown", async () => {
    const { goszakup } = api({ Subjects: null });

    expect(await goszakup.customerCard("000000000000")).toBeNull();
  });
});

describe("GoszakupApi.customerCard extra contacts", () => {
  it("collects the other phones from the addresses once each and names the head from the portal users", async () => {
    const { goszakup, bodies } = api({
      Subjects: [
        {
          bin: "040340008429",
          nameRu: 'АО "Жасыл даму"',
          email: "info@zhasyldamu.kz",
          phone: "8 7172 648-100",
          website: "",
          Address: [
            { phone: "87172648100" },
            { phone: "79-79-41, 27-80-30" },
            { phone: "8 (7172) 79-79-41" },
            { phone: "" }
          ],
          Employees: [
            { fio: "АКАНОВ САКЕН ТУЛЕГЕНОВИЧ", role: 2, disabled: 0 },
            { fio: "БЫВШИЙ РУКОВОДИТЕЛЬ", role: 1, disabled: 1 },
            { fio: "СӘРСЕНБАЙ ЕРЖАН НҰРЛАНҰЛЫ", role: 1, disabled: 0 }
          ]
        }
      ]
    });

    const card = await goszakup.customerCard("040340008429");

    // Основной телефон не считается «другим»; номер без кода города (79-79-41) и тот же с кодом (8 (7172) 79-79-41) — один номер.
    expect(card?.extraPhones).toEqual(["79-79-41", "27-80-30"]);
    expect(card?.head).toBe("СӘРСЕНБАЙ ЕРЖАН НҰРЛАНҰЛЫ");
    expect(bodies[0].query).toMatch(/Address\s*\{[^}]*phone/);
    expect(bodies[0].query).toMatch(/Employees\s*\{[^}]*role/);
  });
});

describe("GoszakupApi.commissionMembers", () => {
  const commission = (members: Array<[string, string, number?]>) =>
    members.map(([fio, role, active]) => ({ fio, active: active ?? 1, RefCommRoles: { nameRu: role } }));

  it("lists who sits on the purchase commissions of the customer with their roles and how often", async () => {
    const { goszakup, bodies } = api({
      TrdBuy: [
        { numberAnno: "1-1", Commission: commission([["ДОСЫМБЕКОВ ДАНИЯР КОТТЫБЕКОВИЧ", "Председатель"], ["МУХАМЕДЖАНОВА АСЕМГУЛЬ АМАНТАЕВНА", "Секретарь"], ["НАУРЫЗБАЕВ АЙБЕК ДИНМУХАМЕДОВИЧ", "Член комиссии"]]) },
        { numberAnno: "2-1", Commission: null },
        { numberAnno: "3-1", Commission: commission([["Досымбеков Данияр Коттыбекович", "Председатель"], ["НАУРЫЗБАЕВ АЙБЕК ДИНМУХАМЕДОВИЧ", "Член комиссии"], ["УШЕДШИЙ ЧЛЕН", "Член комиссии", 0]]) }
      ]
    });

    const result = await goszakup.commissionMembers("040340008429");

    expect(result.tendersChecked).toBe(3);
    expect(result.tendersWithCommission).toBe(2);
    expect(result.members).toEqual([
      { fullName: "ДОСЫМБЕКОВ ДАНИЯР КОТТЫБЕКОВИЧ", roles: ["Председатель"], tenders: 2 },
      { fullName: "МУХАМЕДЖАНОВА АСЕМГУЛЬ АМАНТАЕВНА", roles: ["Секретарь"], tenders: 1 },
      { fullName: "НАУРЫЗБАЕВ АЙБЕК ДИНМУХАМЕДОВИЧ", roles: ["Член комиссии"], tenders: 2 }
    ]);
    expect(bodies[0].variables).toMatchObject({ bin: "040340008429", limit: 10 });
  });

  it("says there is nothing to show when no tender has a commission", async () => {
    const { goszakup } = api({ TrdBuy: [{ numberAnno: "1-1", Commission: null }] });

    expect(await goszakup.commissionMembers("040340008429")).toEqual({ tendersChecked: 1, tendersWithCommission: 0, members: [] });
  });
});

describe("GoszakupApi.findCustomers", () => {
  it("searches by name and limits the answer", async () => {
    const { goszakup, bodies } = api({
      Subjects: [
        { bin: "1", nameRu: "Школа 1", email: "", phone: "", website: "" },
        { bin: "2", nameRu: "Школа 2", email: "x@example.kz", phone: "111", website: "" }
      ]
    });

    const found = await goszakup.findCustomers("Школа", 2);

    expect(found.map((c) => c.bin)).toEqual(["1", "2"]);
    expect(bodies[0].variables).toMatchObject({ name: "Школа", limit: 2 });
  });
});

describe("GoszakupApi.recentTenders", () => {
  it("lists past announcements with their technical specification files first", async () => {
    const { goszakup, bodies } = api({
      TrdBuy: [
        {
          id: 17771156,
          numberAnno: "17771156-1",
          nameRu: "Согласно технической спецификации",
          publishDate: "2026-10-13 09:00:00",
          totalSum: 1500000,
          Files: [
            { nameRu: "Проект договора", originalName: "dogovor.docx", filePath: "https://ows.goszakup.gov.kz/files/1" },
            { nameRu: "Техническая спецификация", originalName: "spec.pdf", filePath: "https://ows.goszakup.gov.kz/files/2" }
          ]
        }
      ]
    });

    const tenders = await goszakup.recentTenders("120540004946", 5);

    expect(tenders).toEqual([
      {
        announceId: 17771156,
        number: "17771156-1",
        publishDate: "2026-10-13",
        title: "Согласно технической спецификации",
        totalSum: 1500000,
        specFiles: [{ name: "spec.pdf", url: "https://ows.goszakup.gov.kz/files/2" }],
        otherFiles: 1
      }
    ]);
    expect(bodies[0].variables).toMatchObject({ bin: "120540004946", limit: 5 });
  });

  it("copes with an announcement without files", async () => {
    const { goszakup } = api({ TrdBuy: [{ id: 1, numberAnno: "1-1", nameRu: "x", publishDate: "2026-10-01 00:00:00", totalSum: null, Files: null }] });

    expect((await goszakup.recentTenders("1", 1))[0]).toMatchObject({ specFiles: [], otherFiles: 0, totalSum: null });
  });
});
