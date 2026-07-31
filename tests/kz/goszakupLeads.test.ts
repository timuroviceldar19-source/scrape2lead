import { describe, expect, it } from "vitest";
import {
  buildGoszakupLeadCandidates,
  detectLeadCity,
  normalizeLeadPhone
} from "../../src/kz/goszakupLeads.js";

describe("goszakup lead selection", () => {
  it("normalizes valid Kazakhstan mobile and landline numbers and rejects obvious junk", () => {
    expect(normalizeLeadPhone("8 (701) 123-45-67")).toEqual({ phone: "+77011234567", phoneOk: true });
    expect(normalizeLeadPhone("+7 7172 55 44 33")).toEqual({ phone: "+77172554433", phoneOk: true });
    expect(normalizeLeadPhone("+7 777 777 77 77")).toEqual({ phone: null, phoneOk: false });
    expect(normalizeLeadPhone("12345")).toEqual({ phone: null, phoneOk: false });
  });

  it("recognizes priority cities from the preferred registry address", () => {
    expect(detectLeadCity({ fullAddressRu: "г. Астана, пр. Республики 1", legalAddress: "г. Алматы" })).toBe("Астана");
    expect(detectLeadCity({ fullAddressRu: null, legalAddress: "Nur-Sultan, улица 2" })).toBe("Астана");
    expect(detectLeadCity({ fullAddressRu: null, legalAddress: null, locationAddress: "Almaty" })).toBe("Алматы");
    expect(detectLeadCity({ fullAddressRu: "г. Караганда" })).toBe("Другой город");
  });

  it("keeps active suppliers first, then dormant suppliers with a contract no older than 18 months", () => {
    const result = buildGoszakupLeadCandidates({
      now: new Date("2026-08-01T00:00:00Z"),
      currentFrom: "2026-05-01",
      historyFrom: "2025-02-01",
      contracts: [
        contract("111111111111", "Актив", "2026-07-10", "1", "Заказчик 1"),
        contract("111111111111", "Актив", "2026-06-10", "2", "Заказчик 2"),
        contract("111111111111", "Актив", "2026-05-10", "3", "Заказчик 3"),
        contract("222222222222", "Спящий", "2026-04-10", "4", "Заказчик 4"),
        contract("333333333333", "Старый", "2024-12-10", "5", "Заказчик 5")
      ],
      registryByBin: new Map([
        ["111111111111", registry("111111111111", "8 701 123 45 67", "Астана")],
        ["222222222222", registry("222222222222", "+7 701 123 45 67", "Алматы")],
        ["333333333333", registry("333333333333", "+7 777 000 00 00", "Караганда")]
      ])
    });

    expect(result.candidates.map((item) => item.bin)).toEqual(["111111111111", "222222222222"]);
    expect(result.candidates[0]).toMatchObject({ currentContracts: 3, lastCustomerName: "Заказчик 1", city: "Астана" });
    expect(result.candidates[1]).toMatchObject({ currentContracts: 0, city: "Алматы" });
  });

  it("deduplicates equal phones by retaining the stronger candidate and separates other cities", () => {
    const result = buildGoszakupLeadCandidates({
      now: new Date("2026-08-01T00:00:00Z"), currentFrom: "2026-05-01", historyFrom: "2025-02-01",
      contracts: [
        contract("111111111111", "Сильный", "2026-07-10", "1", "К1"), contract("111111111111", "Сильный", "2026-06-10", "2", "К1"), contract("111111111111", "Сильный", "2026-05-10", "3", "К1"),
        contract("222222222222", "Дубль", "2026-07-11", "4", "К2"), contract("222222222222", "Дубль", "2026-06-11", "5", "К2"), contract("222222222222", "Дубль", "2026-05-11", "6", "К2"),
        contract("444444444444", "Другой", "2026-07-11", "7", "К3"), contract("444444444444", "Другой", "2026-06-11", "8", "К3"), contract("444444444444", "Другой", "2026-05-11", "9", "К3")
      ],
      registryByBin: new Map([
        ["111111111111", registry("111111111111", "+7 701 111 22 33", "Астана")],
        ["222222222222", registry("222222222222", "+7 701 111 22 33", "Алматы")],
        ["444444444444", registry("444444444444", "+7 701 999 22 33", "Караганда")]
      ])
    });
    expect(result.phoneLeads.map((item) => item.bin)).toEqual(["222222222222", "444444444444"]);
    expect(result.callLeads.map((item) => item.bin)).toEqual(["222222222222"]);
    expect(result.otherCityLeads.map((item) => item.bin)).toEqual(["444444444444"]);
  });

  it("does not impose a call-list limit unless the CLI explicitly supplies one", () => {
    const contracts = Array.from({ length: 101 }, (_, index) => {
      const bin = String(700_000_000_000 + index);
      return [
        contract(bin, `Supplier ${index}`, "2026-07-10", `${index}-1`, "Customer"),
        contract(bin, `Supplier ${index}`, "2026-06-10", `${index}-2`, "Customer"),
        contract(bin, `Supplier ${index}`, "2026-05-10", `${index}-3`, "Customer")
      ];
    }).flat();
    const registryByBin = new Map(Array.from({ length: 101 }, (_, index) => {
      const bin = String(700_000_000_000 + index);
      return [bin, registry(bin, `+7 701 ${String(index).padStart(3, "0")} 12 34`, "Astana")] as const;
    }));

    const result = buildGoszakupLeadCandidates({
      now: new Date("2026-08-01T00:00:00Z"), currentFrom: "2026-05-01", historyFrom: "2026-05-01", contracts, registryByBin
    });

    expect(result.callLeads).toHaveLength(101);
  });
});

function contract(bin: string, supplierName: string, signedAt: string, contractId: string, customerName: string) {
  return { bin, supplierName, signedAt, contractId, contractNumber: `C-${contractId}`, customerName, customerBin: "000000000000", amount: 100_000, searchCode: "262030.100.000021" };
}

function registry(bin: string, phone: string, city: string) {
  return { bin, nameRu: null, phone, fullAddressRu: `г. ${city}`, legalAddress: null, locationAddress: null, economicSector: null, okedList: null, registryUrl: `https://example.test/${bin}` };
}
