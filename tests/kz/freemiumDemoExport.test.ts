import { describe, expect, it } from "vitest";
import { maskDirector, maskEmail, maskPhone } from "../../src/kz/freemiumDemoExport.js";

describe("freemiumDemoExport masking", () => {
  it("maskPhone скрывает середину номера", () => {
    expect(maskPhone("+77009781336")).toBe("+7 (700) XXX-XX-36");
    expect(maskPhone("")).toBe("—");
  });

  it("maskEmail скрывает локальную часть", () => {
    expect(maskEmail("uciha6152@gmail.com")).toBe("u***@gmail.com");
  });

  it("maskDirector скрывает фамилию и имя частично", () => {
    expect(maskDirector("ЖЕКСЕНБЕКОВ АСХАТ")).toBe("Ж*** А***");
  });
});
