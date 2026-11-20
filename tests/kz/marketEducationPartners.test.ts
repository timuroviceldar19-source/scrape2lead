import { describe, expect, it } from "vitest";
import { loadMarketConfig, classifyCode } from "../../src/kz/market/config.js";
import { filterContractUnits } from "../../src/kz/market/filterUnits.js";
import { buildMarketGroupView } from "../../src/kz/market/aggregate.js";

const cfg = loadMarketConfig();
describe("рынок учебных комплектов и партнёров", () => {
  it("включает весь учебный комплект без фильтра описания и ценового порога техники", () => {
    expect(classifyCode("329959.900.000019", cfg, "Кабинет химии")).toEqual({ group: "ИП", kind: "Учебные комплекты" });
    const units = filterContractUnits([{
      id: 1, signDate: "2026-10-15", refContractStatusId: 190, supplierBiin: "170240035230", customerBin: "111111111111",
      ContractUnits: [
        { refEnstruCode: "329959.900.000019", itemPrice: 5000, quantity: 2, totalSum: 10000 },
        { refEnstruCode: "262030.100.000021", itemPrice: 500000, quantity: 1, totalSum: 500000 },
        { refEnstruCode: "310000.000.000000", itemPrice: 100000, quantity: 1, totalSum: 100000 },
      ]
    }], cfg);
    expect(units).toHaveLength(2);
    expect(units.every(u => u.us)).toBe(true);
    const v = buildMarketGroupView("ИП", units, "2026-10-31", cfg);
    expect(v.total.sum).toBe(510000);
    expect(v.total.contracts).toBe(1);
    expect(v.us.sum).toBe(510000);
    expect(v.suppliers[0].name).toBe("F3 и партнёры");
    expect(v.suppliers[0].contractList).toHaveLength(1);
    expect(v.suppliers[0].contractList[0].sum).toBe(510000);
    expect(v.ytd!.companies.find(c => c.bin === "170240035230")!.sum).toBe(510000);
    expect(v.lost).toEqual([]);
    expect(v.kinds.find(k => k.kind === "Учебные комплекты")!.sum).toBe(10000);
  });
});
