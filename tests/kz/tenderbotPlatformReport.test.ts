import { describe, expect, it } from "vitest";
import {
  buildPlatformReport,
  classifyPlatform,
  classifyProduct,
  platformHost,
  renderMarkdown
} from "../../src/kz/tenderbotPlatformReport.js";

describe("classifyPlatform", () => {
  it.each([
    ["https://goszakup.gov.kz/ru/announce/index/1", "collected_gz"],
    ["https://old.goszakup.gov.kz/x", "collected_gz"],
    ["https://zakup.sk.kz/x", "collected_f3"],
    ["https://eep.mitwork.kz/x", "collected_f3"],
    ["https://tizilim.gov.kz/x", "collected_f3"],
    ["https://sell.omarket.kz/preorders/1", "gap"],
    ["https://td.ccx.kz/x", "gap"],
    ["https://eurasiantech-tender.kz/x", "gap"],
    ["https://med.ecc.kz/x", "out_of_scope"],
    ["https://example.kz/x", "other"],
    [null, "other"]
  ])("классифицирует %s", (link, expected) => {
    expect(classifyPlatform(link)).toBe(expected);
  });

  it("достаёт хост и не падает на мусоре", () => {
    expect(platformHost("https://SELL.omarket.kz/preorders/1")).toBe("sell.omarket.kz");
    expect(platformHost("not a url")).toBe("");
    expect(platformHost(null)).toBe("");
  });
});

describe("classifyProduct", () => {
  it.each([
    ["Компьютер", "core"],
    ["Ноутбук, тип 3", "core"],
    ["Панель интерактивная", "core"],
    ["Накопитель SSD 512 Gb", "core"],
    ["Комплект учебного оборудования", "adjacent"],
    ["Кабинет учебный", "adjacent"],
    ["Стол компьютерный", "non_product"],
    ["МФУ лазерное", "non_product"],
    ["Лицензия", "non_product"],
    ["Расходомер", "non_product"],
    ["Нечто неведомое", "unknown"],
    [null, "unknown"]
  ])("классифицирует %s", (name, expected) => {
    expect(classifyProduct(name)).toBe(expected);
  });
});

describe("buildPlatformReport", () => {
  const lots = [
    { id: 1, name: "Компьютер", amount: 1_000_000, goszakupLink: "https://goszakup.gov.kz/a", keyword: "компьютер" },
    { id: 2, name: "Компьютер", amount: 2_000_000, goszakupLink: "https://sell.omarket.kz/preorders/2", keyword: "компьютер" },
    { id: 3, name: "Стол", amount: 500_000, goszakupLink: "https://sell.omarket.kz/preorders/3", keyword: "компьютер" },
    { id: 4, name: "Панель интерактивная", amount: 4_000_000, goszakupLink: "https://td.ccx.kz/4", keyword: "панель интерактивная" },
    { id: 5, name: "Спирометр", amount: 300_000, goszakupLink: "https://med.ecc.kz/5", keyword: "компьютер" }
  ];

  it("считает пробел только по непокрытым площадкам и нашим товарам", () => {
    const report = buildPlatformReport(lots);
    expect(report.gapLots).toBe(2);
    expect(report.gapSum).toBe(6_000_000);
    expect(report.groups.find((group) => group.group === "gap")).toMatchObject({
      lots: 3,
      productLots: 2
    });
  });

  it("пишет пробел в отчёт и не выдаёт за него чужие товары", () => {
    const markdown = renderMarkdown(buildPlatformReport(lots));
    expect(markdown).toContain("**2 лотов на 6.0 млн ₸**");
    expect(markdown).toContain("Панель интерактивная");
    expect(markdown).not.toContain("Спирометр");
  });
});
