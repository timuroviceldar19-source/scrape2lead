import { describe, expect, it, vi } from "vitest";
import {
  buildProcurementCompanyFields,
  COMPANY_BIN_FIELD,
  createProcurementCustomerResolver,
  normalizeRegistryPhones,
  procurementCompanyOriginId,
  type ProcurementCustomerClient,
  type RegistryContact
} from "../../src/bitrix/procurementCustomer.js";
import { PROCUREMENT_ORIGINATOR_ID } from "../../src/bitrix/procurementDealPlan.js";
import type { ProcurementRecord } from "../../src/kz/procurement/types.js";
import { EMPTY_PLAN_PERIOD } from "../../src/kz/procurement/planPeriod.js";

describe("normalizeRegistryPhones", () => {
  it("splits combined registry values, drops junk and duplicates, keeps order", () => {
    expect(normalizeRegistryPhones("57-97-96; 57-93-59", "57-97-96", "нет", null, "12"))
      .toEqual(["57-97-96", "57-93-59"]);
  });

  it("prefixes a bare ten-digit Kazakh number with +7", () => {
    expect(normalizeRegistryPhones("7051641446", "8 7172 690 789")).toEqual(["+77051641446", "8 7172 690 789"]);
  });
});

describe("buildProcurementCompanyFields", () => {
  it("creates an open customer company with BIN, contacts and the registry link", () => {
    const fields = buildProcurementCompanyFields(row(), contact());
    expect(fields).toMatchObject({
      TITLE: "АО \"Заказчик\"",
      COMPANY_TYPE: "CUSTOMER",
      OPENED: "Y",
      ORIGINATOR_ID: PROCUREMENT_ORIGINATOR_ID,
      ORIGIN_ID: "procurement-company:123456789012",
      [COMPANY_BIN_FIELD]: "123456789012",
      PHONE: [{ VALUE: "+77172000000", VALUE_TYPE: "WORK" }, { VALUE: "87770000000", VALUE_TYPE: "WORK" }],
      EMAIL: [{ VALUE: "office@buyer.kz", VALUE_TYPE: "WORK" }],
      WEB: [{ VALUE: "www.buyer.kz", VALUE_TYPE: "WORK" }]
    });
    expect(String(fields.COMMENTS)).toContain("БИН: 123456789012");
    expect(String(fields.COMMENTS)).toContain("https://zakup.gov.kz/registry/pipp/42");
  });

  it("skips an email the registry filled with text and works without a registry match", () => {
    const fields = buildProcurementCompanyFields(row({ customerName: null }), contact({ email: "do not have email" }));
    expect(fields).not.toHaveProperty("EMAIL");
    expect(fields.TITLE).toBe("АО Реестровое имя");
    const bare = buildProcurementCompanyFields(row(), null);
    expect(bare).not.toHaveProperty("PHONE");
    expect(bare[COMPANY_BIN_FIELD]).toBe("123456789012");
  });
});

describe("createProcurementCustomerResolver", () => {
  it("links an existing company found by BIN without touching the registry", async () => {
    const client = fakeClient({ byBin: "501" });
    const lookup = vi.fn();
    const resolve = createProcurementCustomerResolver(client, lookup, { execute: true });
    await expect(resolve(row())).resolves.toEqual({ action: "existing", companyId: "501", warning: null });
    expect(lookup).not.toHaveBeenCalled();
    expect(client.addCompany).not.toHaveBeenCalled();
  });

  it("falls back to a company this collector created earlier", async () => {
    const client = fakeClient({ byOrigin: "502" });
    const resolve = createProcurementCustomerResolver(client, vi.fn(), { execute: true });
    await expect(resolve(row())).resolves.toMatchObject({ action: "existing", companyId: "502" });
    expect(client.findCompanyByOrigin).toHaveBeenCalledWith(PROCUREMENT_ORIGINATOR_ID, procurementCompanyOriginId("123456789012"));
  });

  it("creates the company once per BIN with registry contacts", async () => {
    const client = fakeClient({ added: "900" });
    const lookup = vi.fn(async () => contact());
    const resolve = createProcurementCustomerResolver(client, lookup, { execute: true });
    const [first, second] = await Promise.all([resolve(row()), resolve(row({ externalId: "43" }))]);
    expect(first).toMatchObject({ action: "create", companyId: "900" });
    expect(second).toMatchObject({ action: "create", companyId: "900" });
    expect(client.addCompany).toHaveBeenCalledTimes(1);
    expect(client.addCompany.mock.calls[0]?.[0]).toMatchObject({ PHONE: expect.any(Array) });
  });

  it("plans the company in dry-run without writing", async () => {
    const client = fakeClient({});
    const resolve = createProcurementCustomerResolver(client, vi.fn(async () => contact()), { execute: false });
    await expect(resolve(row())).resolves.toMatchObject({ action: "create", companyId: null });
    expect(client.addCompany).not.toHaveBeenCalled();
  });

  it("still creates the company without phones when the registry lookup fails", async () => {
    const client = fakeClient({ added: "901" });
    const resolve = createProcurementCustomerResolver(client, vi.fn(async () => { throw new Error("zakup down"); }), { execute: true });
    const result = await resolve(row());
    expect(result).toMatchObject({ action: "create", companyId: "901" });
    expect(result.warning).toContain("zakup down");
    expect(client.addCompany.mock.calls[0]?.[0]).not.toHaveProperty("PHONE");
  });

  it("does nothing for a record without a valid BIN", async () => {
    const client = fakeClient({});
    const resolve = createProcurementCustomerResolver(client, vi.fn(), { execute: true });
    await expect(resolve(row({ customerBin: "12345" }))).resolves.toEqual({ action: "none", companyId: null, warning: null });
    expect(client.findCompanyByBin).not.toHaveBeenCalled();
  });
});

function fakeClient(options: { byBin?: string; byOrigin?: string; added?: string }) {
  return {
    findCompanyByBin: vi.fn(async (_bin: string) => options.byBin ?? null),
    findCompanyByOrigin: vi.fn(async (_originator: string, _origin: string) => options.byOrigin ?? null),
    addCompany: vi.fn(async (_fields: Record<string, unknown>) => options.added ?? "1")
  } satisfies ProcurementCustomerClient;
}

function contact(overrides: Partial<RegistryContact> = {}): RegistryContact {
  return { name: "АО Реестровое имя", phones: ["+77172000000", "87770000000"], email: "office@buyer.kz",
    website: "www.buyer.kz", registryUrl: "https://zakup.gov.kz/registry/pipp/42", ...overrides };
}

function row(overrides: Partial<ProcurementRecord> = {}): ProcurementRecord {
  return { source: "samruk", recordKind: "plan", externalId: "42", parentExternalId: null, status: "Утвержден",
    productName: "Ноутбук", description: "", truCode: "262011.100.000002", customerName: "АО \"Заказчик\"",
    customerBin: "123456789012", amount: 1_000_000, currency: "KZT", startDate: null, endDate: null,
    url: "https://example.kz/42", purchaseMethod: null, ...EMPTY_PLAN_PERIOD,
    collectedAt: "2026-11-20T00:00:00Z", ...overrides };
}
