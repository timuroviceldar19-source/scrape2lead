import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkGzQuantityRules,
  classifyGzItem,
  gzQuantityRulesSchema,
  loadGzQuantityRules,
  parseGzAmount,
  parseGzQuantity
} from "../../src/bitrix/gzQuantityRules.js";

const rules = loadGzQuantityRules("config/gz-quantity-rules.json");
// Сумма по умолчанию ниже порога keepFromAmount (2 млн ₸), чтобы проверять именно количество.
const check = (name: string, quantity: string, truCode = "", amount: string | number = "900 000") =>
  checkGzQuantityRules({ name, quantity, truCode, amount }, rules);
const ruleOf = (name: string, truCode = "") => classifyGzItem({ name, truCode }, rules)?.name ?? null;

describe("parseGzQuantity", () => {
  it("reads the portal formats", () => {
    expect(parseGzQuantity("4")).toBe(4);
    expect(parseGzQuantity("1 200")).toBe(1200);
    expect(parseGzQuantity("1 200")).toBe(1200);
    expect(parseGzQuantity("2,000")).toBe(2);
    expect(parseGzQuantity("2.5")).toBe(2.5);
    expect(parseGzQuantity("20 шт")).toBe(20);
    expect(parseGzQuantity(15)).toBe(15);
  });

  it("returns null when there is no number", () => {
    expect(parseGzQuantity("")).toBeNull();
    expect(parseGzQuantity(null)).toBeNull();
    expect(parseGzQuantity(undefined)).toBeNull();
    expect(parseGzQuantity("не указано")).toBeNull();
  });
});

describe("parseGzAmount", () => {
  it("reads plan and lot sums", () => {
    expect(parseGzAmount("4 482 758.60")).toBe(4482758.6);
    expect(parseGzAmount("4\u00a0482\u00a0758,60")).toBe(4482758.6);
    expect(parseGzAmount("2000000")).toBe(2000000);
    expect(parseGzAmount(1500000)).toBe(1500000);
  });

  it("returns null for an empty or broken sum", () => {
    expect(parseGzAmount("")).toBeNull();
    expect(parseGzAmount(null)).toBeNull();
    expect(parseGzAmount("около миллиона")).toBeNull();
  });
});

describe("shipped GZ quantity rules: classification", () => {
  it("treats computers, monoblocks and laptops as PC", () => {
    expect(ruleOf("Компьютер", "262013.000.000011")).toBe("pc");
    expect(ruleOf("Компьютер персональный настольный (моноблок)")).toBe("pc");
    expect(ruleOf("Моноблок 23.8")).toBe("pc");
    expect(ruleOf("Ноутбук", "262011.100.000001")).toBe("pc");
    expect(ruleOf("Бизнес-ноутбук")).toBe("pc");
    expect(ruleOf("Системный блок")).toBe("pc");
    // Название по ЕНС ТРУ: 35 сделок робота за 13.10–13.11.2026.
    expect(ruleOf("Блок системный")).toBe("pc");
    // Лоты, найденные по слову «процессор», — это системные блоки.
    expect(ruleOf("Процессор")).toBe("pc");
    expect(ruleOf("Станция рабочая")).toBe("pc");
    expect(ruleOf("Компьютер в комплекте с монитором")).toBe("pc");
  });

  it("does not treat a computer class or computer furniture as a PC", () => {
    expect(ruleOf("Комплект оборудования для компьютерного класса")).toBeNull();
    expect(ruleOf("Стол компьютерный")).toBeNull();
    expect(ruleOf("Радар-процессор RP-4.2")).toBeNull();
    expect(ruleOf("Комплект учебного оборудования")).toBeNull();
  });

  it("treats monitors by ENSTRU code or by a name that starts with «Монитор»", () => {
    expect(ruleOf("Монитор", "262017.100.000002")).toBe("monitors");
    expect(ruleOf("Монитор для компьютера")).toBe("monitors");
  });

  it("treats MFU and printers by ENSTRU code or by name", () => {
    expect(ruleOf("Устройство многофункциональное", "262018.900.000001")).toBe("mfu-printers");
    expect(ruleOf("МФУ лазерное A4")).toBe("mfu-printers");
    expect(ruleOf("Принтер", "262016.300.000003")).toBe("mfu-printers");
  });

  it("keeps interactive panels out of every quantity rule", () => {
    expect(ruleOf("Панель интерактивная", "262030.100.000043")).toBe("panels");
    expect(ruleOf("Интерактивная панель с компьютером")).toBe("panels");
    expect(ruleOf("Доска специальная")).toBe("panels");
    expect(ruleOf("Панель жидкокристаллическая")).toBe("panels");
  });
});

describe("shipped GZ quantity rules: decisions", () => {
  it("creates PC deals only from 3 pcs", () => {
    expect(check("Компьютер", "2", "262013.000.000011")).toMatchObject({
      allowed: false, ruleName: "pc", quantity: 2, reason: "pc: количество 2, нужно не меньше 3 или сумма от 2 000 000 ₸"
    });
    expect(check("Ноутбук", "1").allowed).toBe(false);
    expect(check("Моноблок", "3").allowed).toBe(true);
    expect(check("Компьютер", "25").allowed).toBe(true);
  });

  it("never creates monitor deals, whatever the quantity", () => {
    expect(check("Монитор", "100", "262017.100.000002")).toMatchObject({
      allowed: false, ruleName: "monitors", reason: "monitors: такие позиции не заводим"
    });
  });

  it("creates MFU and printer deals only above 10 pcs", () => {
    expect(check("Устройство многофункциональное", "10", "262018.900.000001")).toMatchObject({
      allowed: false, ruleName: "mfu-printers", reason: "mfu-printers: количество 10, нужно не меньше 11 или сумма от 2 000 000 ₸"
    });
    expect(check("Принтер", "11").allowed).toBe(true);
  });

  it("creates small but expensive PC and MFU deals from 2 mln tenge", () => {
    // Сделка 48719: «Станция рабочая», 2 шт на 14,1 млн.
    expect(check("Станция рабочая", "2", "", "14 100 000")).toMatchObject({ allowed: true, ruleName: "pc", keptByAmount: true, reason: null });
    expect(check("Ноутбук", "1", "", "2 000 000").allowed).toBe(true);
    expect(check("Ноутбук", "1", "", "1 999 999.99").allowed).toBe(false);
    expect(check("Устройство многофункциональное", "8", "", 2_400_000)).toMatchObject({ allowed: true, keptByAmount: true });
  });

  it("does not let monitors in even when the sum is large", () => {
    // Сделка 48955: «Монитор», 60 шт на 5,1 млн.
    expect(check("Монитор", "60", "262017.100.000000", "5 100 000")).toMatchObject({ allowed: false, keptByAmount: false });
  });

  it("falls back to the quantity rule when the sum cannot be read", () => {
    expect(check("Компьютер", "2", "", "")).toMatchObject({ allowed: false, keptByAmount: false });
  });

  it("leaves panels and unclassified items without a quantity limit", () => {
    expect(check("Панель интерактивная", "1")).toMatchObject({ allowed: true, ruleName: "panels", reason: null });
    expect(check("Комплект оборудования для компьютерного класса", "1")).toMatchObject({ allowed: true, ruleName: null });
  });

  it("creates the deal with a warning when the quantity cannot be read", () => {
    expect(check("Компьютер", "")).toMatchObject({
      allowed: true, ruleName: "pc", reason: null,
      warning: "pc: количество не прочитано (пусто), сделка заводится"
    });
  });

  it("treats a zero quantity as unknown, not as zero pieces", () => {
    // Сделка 41533: «Компьютер», 0 шт на 500 млн.
    expect(check("Компьютер", "0")).toMatchObject({
      allowed: true, ruleName: "pc", warning: "pc: количество не прочитано (0), сделка заводится"
    });
  });
});

describe("gzQuantityRulesSchema", () => {
  it("rejects a rule without a matcher", () => {
    expect(() => gzQuantityRulesSchema.parse({ rules: [{ name: "bad", minQuantity: 3 }] }))
      .toThrow(/truCodePrefixes and\/or namePatterns/);
  });

  it("rejects keepFromAmount without minQuantity", () => {
    expect(() => gzQuantityRulesSchema.parse({ rules: [{ name: "bad", namePatterns: ["x"], exclude: true, keepFromAmount: 1 }] }))
      .toThrow(/keepFromAmount works only together with minQuantity/);
  });

  it("rejects a broken regular expression", () => {
    expect(() => gzQuantityRulesSchema.parse({ rules: [{ name: "bad", namePatterns: ["("] }] }))
      .toThrow(/invalid name pattern/);
  });

  it("fails loudly when the config file is missing", () => {
    const missing = path.join(os.tmpdir(), `gz-quantity-missing-${process.pid}.json`);
    expect(fs.existsSync(missing)).toBe(false);
    expect(() => loadGzQuantityRules(missing)).toThrow(/cannot read/);
  });
});

describe("shipped collectors and quantity rules agree", () => {
  const keywordsOf = (file: string) => (JSON.parse(fs.readFileSync(file, "utf8")) as { keywords: string[] }).keywords;

  it("puts every PK plan keyword under the PC or MFU/printer limit, never under monitors", () => {
    for (const keyword of keywordsOf("config/gz-plans.pk.json")) {
      expect(["pc", "mfu-printers"]).toContain(ruleOf(keyword));
    }
  });

  it("keeps the panel plan keywords free of any limit", () => {
    for (const keyword of keywordsOf("config/gz-plans.json")) expect(ruleOf(keyword)).toBe("panels");
  });

  it("keeps the panel lot keywords free of any limit", () => {
    const panels = keywordsOf("config/gz-lots-computers.json").filter((keyword) => /панел|доска/i.test(keyword));
    expect(panels.length).toBeGreaterThan(0);
    for (const keyword of panels) expect(ruleOf(keyword)).toBe("panels");
  });
});

describe("push scripts apply the quantity rules only to new deals", () => {
  it("plans: checks the rules only when the row would create a deal", () => {
    const source = fs.readFileSync("scripts/bitrix-push-gz-deals.mts", "utf8");
    expect(source).toContain("loadGzQuantityRules(args.quantityRulesPath)");
    expect(source).toMatch(/baseAction === "create"\s*\?\s*checkGzQuantityRules/);
    expect(source).toContain("quantity: row.quantity, amount: row.amount }");
    expect(source).toContain("filtered=${count(\"filtered\")}");
  });

  it("lots: checks the rules only for lots without a deal", () => {
    const source = fs.readFileSync("scripts/bitrix-push-gz-lots.mts", "utf8");
    expect(source).toContain("loadGzQuantityRules(args.quantityRulesPath)");
    expect(source).toMatch(/if \(!existingDeals\[rowIndex\]\) \{\s*const quantity = checkGzQuantityRules/);
    expect(source).toContain("quantity: row.quantity, amount: row.amount }");
    expect(source).toContain("filtered=${stats.filtered}");
  });
});
