import { describe, expect, it } from "vitest";
import { fetchGzCustomerContracts, withGzSourceFallback } from "../../src/kz/zakupGzRegistry.js";

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
