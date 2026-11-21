import { describe, expect, it } from "vitest";
import { createZakupRegistryContactLookup } from "../../src/kz/procurement/registryContact.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const opts = { pauseMs: 0, retryDelayMs: 0, maxRetries: 0, orgCachePath: "" };

describe("createZakupRegistryContactLookup", () => {
  it("finds the organization by BIN and returns its registry contacts", async () => {
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/public/organizations/")) {
        expect(u.searchParams.get("q")).toBe("970740000838");
        return json([{ id: 7, iin_bin: "111111111111" }, { id: 69954, iin_bin: "970740000838" }]);
      }
      if (u.pathname.endsWith("/public/organizations/69954/")) return json({
        id: 69954, iin_bin: "970740000838", name_ru: "АО KEGOC", phone: "8 7172 690 789",
        email: "office@kegoc.kz", website: "www.kegoc.kz",
        addresses: [{ phone: "87777171087" }, { phone: "8 7172 690 789" }, { phone: null }]
      });
      throw new Error(`unexpected ${u.pathname}`);
    }) as typeof fetch;

    const lookup = createZakupRegistryContactLookup({ ...opts, fetchFn });
    await expect(lookup("970740000838")).resolves.toEqual({
      name: "АО KEGOC",
      phones: ["8 7172 690 789", "87777171087"],
      email: "office@kegoc.kz",
      website: "www.kegoc.kz",
      registryUrl: "https://zakup.gov.kz/registry/pipp/69954"
    });
  });

  it("returns null when the registry has no organization with that BIN", async () => {
    const fetchFn = (async () => json([{ id: 7, iin_bin: "111111111111" }])) as typeof fetch;
    await expect(createZakupRegistryContactLookup({ ...opts, fetchFn })("140340010451")).resolves.toBeNull();
  });

  it("propagates transport failures so the caller can report them", async () => {
    const fetchFn = (async () => json({ detail: "boom" }, 500)) as typeof fetch;
    await expect(createZakupRegistryContactLookup({ ...opts, fetchFn })("970740000838")).rejects.toThrow();
  });
});
