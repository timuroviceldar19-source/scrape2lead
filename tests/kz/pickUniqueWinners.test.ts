import { describe, expect, it } from "vitest";
import { pickUniqueWinnersByBin } from "../../src/kz/outreachDigest.js";
import type { OutreachWinner } from "../../src/kz/outreachDigest.js";

function winner(bin: string, amount: number, name: string): OutreachWinner {
  return {
    bin,
    company_name: name,
    director: null,
    phone: null,
    email: null,
    gis_phone: "",
    contract_number: `CT-${bin}`,
    contract_name: "Договор",
    customer_name: null,
    amount,
    amount_raw: String(amount),
    contract_date: null,
    status: null,
    url: null
  };
}

describe("pickUniqueWinnersByBin", () => {
  it("оставляет один контракт на БИН — с максимальной суммой", () => {
    const result = pickUniqueWinnersByBin(
      [
        winner("111", 100, "A"),
        winner("111", 500, "A"),
        winner("222", 300, "B")
      ],
      10
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.bin).toBe("111");
    expect(result[0]?.amount).toBe(500);
    expect(result[1]?.bin).toBe("222");
  });

  it("сортирует по сумме и режет limit", () => {
    const result = pickUniqueWinnersByBin(
      [winner("1", 10, "A"), winner("2", 100, "B"), winner("3", 50, "C")],
      2
    );
    expect(result.map((w) => w.bin)).toEqual(["2", "3"]);
  });
});
