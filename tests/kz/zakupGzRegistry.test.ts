import { describe, expect, it } from "vitest";
import { fetchGzCustomerContracts, withGzSourceFallback, ZakupOrganizations } from "../../src/kz/zakupGzRegistry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const page = (results: unknown[]) => ({ count: results.length, next: null, results });
const json = (body: unknown) => new Response(JSON.stringify(body));
const opts = { pauseMs: 0, retryDelayMs: 0, maxRetries: 0, orgCachePath: "" };

describe("договоры zakup в формате итогов ows", () => {
  it("переводит год через справочник, БИН через общий кэш, корень и версии; убирает дубли позиций", async () => {
    const calls: URL[] = [];
    const fetchFn = (async (url: string) => {
      const u = new URL(url); calls.push(u);
      if (u.pathname.endsWith("/years/")) return json([{ id: 12, year: 2026 }]);
      if (u.pathname.endsWith("/contract-statuses/")) return json([{ id: 6, egz_code: "190", name: "Действует" }]);
      if (u.pathname.endsWith("/organizations/")) return json(page([{ id: 42, iin_bin: "990000000001" }]));
      if (u.pathname.endsWith("/subjects/")) return json([
        { external_id: 9, timestamp: 1, contract_price_without_vat: 100, plan_item: { external_id: 200, root: { external_id: 100 }, name_ru: "Экран", enstru: { code: "279020.100.000002" } }, contract: { supplier_organization: { id: 8, iin_bin: "990000000002" } } },
        { external_id: 9, timestamp: 2, contract_price_without_vat: 120, plan_item: { external_id: 200, root: { external_id: 100 }, name_ru: "Экран", enstru: { code: "279020.100.000002" } }, contract: { supplier_organization: { id: 8, iin_bin: "990000000002" } } }
      ]);
      if (u.pathname.endsWith("/contracts/")) return json(page([{ id: 7, external_id: 3, year_id: 12, customer_organization_id: 42, supplier_organization_id: 8, contract_number_sys: "990000000001/260001/00", sign_date: "2026-10-29", status_id: 6, supplier_organization_name: "Поставщик" }]));
      throw new Error(`unexpected ${u.pathname}`);
    }) as typeof fetch;
    const rows = await fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn });
    expect(rows).toEqual([{ contractNumberSys: "990000000001/260001/00", signDate: "2026-10-29", supplierBiin: "990000000002", Supplier: { nameRu: "Поставщик" }, RefContractStatus: { nameRu: "Действует" }, deleted: 0, ContractUnits: [{ plnPointId: 200, totalSum: 120, refEnstruCode: "279020.100.000002", Plans: { rootrecordId: 100, nameRu: "Экран" } }] }]);
    const listed = calls.find(u => u.pathname.endsWith("/contracts/"))!;
    expect(listed.searchParams.get("year_id")).toBe("12");
    expect(listed.searchParams.get("customer_organization_id")).toBe("42");
    expect(listed.searchParams.get("system_id")).toBe("1");
  });

  it("не считает отсутствие года или организации успешным пустым ответом", async () => {
    const fetchFn = (async () => json([])) as typeof fetch;
    await expect(fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn })).rejects.toThrow();
  });
});

describe("выбор источника", () => {
  it("не вызывает ows при успешном пустом ответе zakup", async () => {
    await expect(withGzSourceFallback(async () => [], async () => { throw Error("unexpected"); }, "token")).resolves.toEqual([]);
  });
  it("использует ows только при ошибке zakup и заданном токене", async () => {
    await expect(withGzSourceFallback(async () => { throw Error("public down"); }, async () => [1], "token")).resolves.toEqual([1]);
  });
  it("сохраняет обе причины ошибки", async () => {
    await expect(withGzSourceFallback(async () => { throw Error("public down"); }, async () => { throw Error("Access denied"); }, "token")).rejects.toThrow(/public down.*Access denied/s);
    await expect(withGzSourceFallback(async () => { throw Error("public down"); }, async () => [], undefined)).rejects.toThrow("public down");
  });
});

describe("справочники, неполные данные и общий кэш", () => {
  it("фильтрует по обоим полным кодам и началу года, не отправляя префикс; договор с двух кодов читает один раз", async () => {
    const base = api(); const listed: URL[] = []; let subjects = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/contracts/")) listed.push(u);
      if (u.pathname.endsWith("/subjects/")) subjects++;
      return base(url, init);
    }) as typeof fetch;
    await fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn, enstruCodes: ["262040", "262030.100.000043", "279020.100.000002", "279020.100.000002"] });
    expect(listed.map(u => u.searchParams.get("enstru_code")).sort()).toEqual(["262030.100.000043", "279020.100.000002"]);
    expect(listed.every(u => u.searchParams.get("sign_date__gte") === "2026-01-01")).toBe(true);
    expect(subjects).toBe(1);
  });
  function api(over: Record<string, unknown> = {}, subjects: unknown = [], status = { id: 6, egz_code: "190", name: "Действует" }): typeof fetch {
    return (async (url: string) => {
      const p = new URL(url).pathname;
      if (p.endsWith("/organizations/")) return json(page([{ id: 42, iin_bin: "990000000001" }]));
      if (p.endsWith("/organizations/8/")) return json({ id: 8, iin_bin: "990000000002" });
      if (p.endsWith("/years/")) return json([{ id: 12, year: 2026 }]);
      if (p.endsWith("/contract-statuses/")) return json([status]);
      if (p.endsWith("/contracts/")) return json(page([{ id: 7, external_id: 3, status_id: status.id, supplier_organization_id: 8, contract_number_sys: "990000000001/260001/00", ...over }]));
      if (p.endsWith("/subjects/")) return json(subjects);
      if (p.endsWith("/contracts/7/")) return json({ supplier_organization: { id: 8, iin_bin: "990000000002" } });
      throw Error("unexpected path");
    }) as typeof fetch;
  }

  it.each([
    ["190", "Действует"], ["390", "Исполнен"], ["460", "Передан.Действует"], ["450", "Создано доп.соглашение"],
    ["340", "Расторгнут в одностороннем порядке"], ["350", "Расторгнут по соглашению сторон"], ["455", "Изменен"]
  ])("берёт статус ЭГЗ %s из справочника: %s", async (egz_code, name) => {
    const [row] = await fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn: api({}, [], { id: 6, egz_code, name }) });
    expect(row.RefContractStatus?.nameRu).toBe(name);
    expect(row.supplierBiin).toBe("990000000002");
  });

  it("сохраняет явное удаление договора", async () => {
    const [row] = await fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn: api({ is_externally_deleted: true }) });
    expect(row.deleted).toBe(1);
  });

  it("читает БИН из карточки договора, если организация не найдена отдельным запросом", async () => {
    const base = api();
    const fetchFn = (async (url: string, init?: RequestInit) => new URL(url).pathname.endsWith("/organizations/8/")
      ? new Response("not found", { status: 404 }) : base(url, init)) as typeof fetch;
    const [row] = await fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn });
    expect(row.supplierBiin).toBe("990000000002");
  });

  it.each([
    [{ supplier_organization_id: null }, [], "без поставщика"],
    [{ contract_number_sys: null }, [], "без системного номера"],
    [{}, { results: [], next: "/next/" }, "неполные позиции"]
  ])("не превращает повреждённый договор в пустой результат", async (row, subjects, message) => {
    await expect(fetchGzCustomerContracts("990000000001", [2026], { ...opts, fetchFn: api(row as Record<string, unknown>, subjects) })).rejects.toThrow(String(message));
  });

  it("после ошибки zakup читает все запрошенные годы через ows", async () => {
    const years: number[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (new URL(url).hostname === "zakup.gov.kz") throw Error("offline");
      years.push(JSON.parse(String(init?.body)).variables.year);
      return json({ data: { Contract: null } });
    }) as typeof fetch;
    expect(await fetchGzCustomerContracts("990000000001", [2025, 2026, 2026], { ...opts, token: "t", fetchFn })).toEqual([]);
    expect(years).toEqual([2025, 2026]);
  });

  it("обратный поиск использует прежний файл id → БИН и сохраняет соседние записи", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zakup-org-"));
    const file = path.join(dir, "orgs.json");
    try {
      fs.writeFileSync(file, JSON.stringify({ "42": "990000000001" }));
      const orgs = new ZakupOrganizations({ ...opts, orgCachePath: file, fetchFn: api() });
      expect(await orgs.idForBin("990000000001")).toBe(42);
      expect(await orgs.binForId(42)).toBe("990000000001");
      fs.writeFileSync(file, JSON.stringify({ "42": "990000000001", "99": "990000000099" }));
      expect(await orgs.binForId(8)).toBe("990000000002");
      orgs.remember({ id: 0, iin_bin: "bad" }); orgs.save();
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ "42": "990000000001", "99": "990000000099", "8": "990000000002" });
      await expect(orgs.idForBin("invalid")).rejects.toThrow("12 цифр");
    } finally {
      if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + "zakup-org-")) throw Error("unsafe cleanup");
      fs.rmSync(dir, { recursive: true });
    }
  });
});

it('не публикует частичный индекс заказчика при 404 позиции договора', async () => {
  const { loadZakupCustomerContracts } = await import('../../src/kz/zakupGzRegistry.js');
  const seen: unknown[] = [];
  const fetchFn = (async (url: string) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/organizations/')) return json(page([{ id: 42, iin_bin: '990000000001' }]));
    if (p.endsWith('/years/')) return json([{ id: 12, year: 2026 }]);
    if (p.endsWith('/contracts/')) return json(page([{ id: 7 }, { id: 8 }]));
    if (p.endsWith('/7/subjects/')) return json([{ plan_item: { id: 10, external_id: 100 } }]);
    if (p.endsWith('/8/subjects/')) return new Response('', { status: 404 });
    throw Error(p);
  }) as typeof fetch;
  await expect(loadZakupCustomerContracts('990000000001', [2026], { ...opts, fetchFn, concurrency: 1, onPlanItem: x => seen.push(x) })).rejects.toThrow('404');
  expect(seen).toEqual([]);
});
