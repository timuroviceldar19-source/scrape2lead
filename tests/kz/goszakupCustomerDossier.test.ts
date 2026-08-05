import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAnnounceContractsUrl,
  buildAnnounceUrl,
  buildCustomerDossier,
  buildCustomerLotsUrl
} from "../../src/kz/goszakupCustomerDossier.js";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "gz-dossier");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function loaderFor(pages: Record<string, string>, visited: string[] = []) {
  return async (url: string): Promise<string> => {
    visited.push(url);
    const page = Object.entries(pages).find(([fragment]) => url.includes(fragment));
    return page ? page[1] : "<html></html>";
  };
}

describe("dossier URL builders", () => {
  it("filters lots by customer BIN and item name", () => {
    const url = buildCustomerLotsUrl({ bin: "031040002509", query: "Компьютер" });
    expect(url).toContain("filter%5Bcustomer%5D=031040002509");
    expect(url).toContain("filter%5Bname%5D=%D0%9A%D0%BE%D0%BC%D0%BF%D1%8C%D1%8E%D1%82%D0%B5%D1%80");
  });

  it("points at the announcement and its contracts tab", () => {
    expect(buildAnnounceUrl("16744298")).toBe("https://www.goszakup.gov.kz/ru/announce/index/16744298");
    expect(buildAnnounceContractsUrl("16744298")).toBe(
      "https://www.goszakup.gov.kz/ru/announce/index/16744298?tab=contracts"
    );
  });
});

describe("buildCustomerDossier", () => {
  const pages = {
    "search/lots": fixture("lots-search.html"),
    "tab=contracts": fixture("announce-contracts.html"),
    "announce/index": fixture("announce-general.html")
  };

  it("collects lot history, officers and awards for the customer", async () => {
    const dossier = await buildCustomerDossier({
      bin: "031040002509",
      query: "Компьютер",
      loadPage: loaderFor(pages)
    });

    expect(dossier.lots).toHaveLength(2);
    expect(dossier.officers).toEqual([
      {
        fullName: "ТУРГАМБЕКОВА НАЗИРА ОМАРКЫЗЫ",
        position: "Специалист отдела государственных закупок и обеспечения",
        email: "tazalyk.almaty@mail.ru",
        announceIds: ["16744298", "16714116"]
      }
    ]);
    expect(dossier.summary.lotsTotal).toBe(2);
    expect(dossier.summary.lotsFailed).toBe(1);
  });

  it("counts a lot once even when the contract has a supplementary agreement", async () => {
    const dossier = await buildCustomerDossier({
      bin: "031040002509",
      query: "Компьютер",
      loadPage: loaderFor(pages)
    });

    const steppe = dossier.summary.suppliers.find((item) => item.bin === "190140006079");
    expect(steppe?.wins).toBe(1);
    expect(steppe?.contractedTotal).toBe(14_284_920);
  });

  it("reports how far below the planned amount the customer settles", async () => {
    const dossier = await buildCustomerDossier({
      bin: "031040002509",
      query: "Компьютер",
      loadPage: loaderFor(pages)
    });

    expect(dossier.summary.plannedTotal).toBe(22_332_800);
    expect(dossier.summary.contractedTotal).toBe(14_284_920);
    expect(dossier.summary.averageDiscountPercent).toBeCloseTo(36.04, 1);
    expect(dossier.summary.priceHistory[0]).toMatchObject({
      lotNumber: "81335611-ЗЦП2",
      quantity: 40,
      plannedUnitPrice: 558_320,
      contractedUnitPrice: 357_123
    });
  });

  it("stops after maxAnnouncements so a large customer cannot fan out unbounded", async () => {
    const visited: string[] = [];
    await buildCustomerDossier({
      bin: "031040002509",
      query: "Компьютер",
      maxAnnouncements: 1,
      loadPage: loaderFor(pages, visited)
    });

    expect(visited.filter((url) => url.includes("tab=contracts"))).toHaveLength(1);
  });

  it("returns an empty dossier when the customer never bought the item", async () => {
    const dossier = await buildCustomerDossier({
      bin: "031040002509",
      query: "Ледокол",
      loadPage: loaderFor({})
    });

    expect(dossier.lots).toEqual([]);
    expect(dossier.summary.averageDiscountPercent).toBeNull();
  });
});
