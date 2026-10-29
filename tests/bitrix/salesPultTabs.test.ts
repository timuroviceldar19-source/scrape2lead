import { describe, it, expect } from "vitest";
import { renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import type { RegisterView } from "../../src/bitrix/salesPult/register/types.js";
import fs from "node:fs";

describe("salesPult tabs & standalone register page rendering", () => {
  const basePayload: SalesPultPayload = JSON.parse(
    fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8")
  );

  const fixtureRegisterWithTag: RegisterView = {
    file: "ОП 28.10.26.xlsx",
    asOf: "2026-10-28",
    month: "2026-10",
    total: {
      sale: 293000000,
      val: 78500000,
      bonusMop: 2350000,
      bonusRop: 390000,
      contracts: 84,
      plan: 250000000,
      b2bPlan: 40000000,
      b2bSale: 35000000
    },
    daily: [{ d: "2026-10-01", sale: 10000000 }],
    managers: [
      {
        name: "Эльмира",
        sale: 50000000,
        val: 15000000,
        margin: 0.3,
        bonus: 450000,
        plan: 30000000,
        contracts: 12,
        missCount: 0,
        missSum: 0,
        rows: []
      }
    ],
    mix: [
      {
        kind: "Интерактивные панели",
        group: "ИП",
        sale: 118400000,
        val: 35000000,
        qty: 50,
        contracts: 30
      }
    ],
    channels: [{ name: "ЗЦП", sale: 100000000, val: 30000000, contracts: 25 }],
    groups: [
      { g: "ИП", sale: 118400000, val: 35000000 },
      { g: "КТ", sale: 174500000, val: 43500000 }
    ],
    missing: [],
    crmExtra: 0,
    rows: [
      {
        date: "2026-10-01",
        type: "зцп",
        customer: "ТЕСТ-МЕТКА-РЕЕСТРА",
        qty: 2,
        product: "панель",
        cost: 500000,
        extras: 0,
        sale: 1200000,
        portal: 1200000,
        val: 200000,
        bonusMop: 6000,
        bonusRop: 1000,
        manager: "Эльмира",
        note: null,
        group: "ИП",
        kind: "Интерактивные панели",
        channel: "Запрос ценовых предложений"
      }
    ]
  };

  it("renders header sections navigation with link to reg.html and tabs for pult, ip, kt", () => {
    const html = renderPultHtml(basePayload);

    expect(html).toContain('nav class="sections" aria-label="Разделы"');
    expect(html).toContain('href="#pult" data-t="pult"');
    expect(html).toContain('href="./reg.html"');
    expect(html).toContain('href="#ip" data-t="ip"');
    expect(html).toContain('href="#kt" data-t="kt"');

    // Pult page has only pult, ip, kt containers, NO tab-reg container
    expect(html).toContain('id="tab-pult"');
    expect(html).toContain('id="tab-ip"');
    expect(html).toContain('id="tab-kt"');
    expect(html).not.toContain('id="tab-reg"');
  });

  const CYRILLIC_VAL_WORD = /(?:^|[^а-яёА-ЯЁ])вал(?:[^а-яёА-ЯЁ]|$)/i;
  const CYRILLIC_BONUS_WORD = /(?:^|[^а-яёА-ЯЁ])бонус/i;

  it("renderPultHtml never contains register fixture tag, val or bonus", () => {
    // Even if register property is somehow passed into payload, renderPultHtml strips it
    const testPayload = {
      ...basePayload,
      register: fixtureRegisterWithTag
    } as any;

    const html = renderPultHtml(testPayload);

    expect(html).not.toContain("ТЕСТ-МЕТКА-РЕЕСТРА");
    expect(html).not.toMatch(CYRILLIC_VAL_WORD);
    expect(html).not.toMatch(CYRILLIC_BONUS_WORD);
    expect(html).not.toContain('"register"');
  });

  it("renderRegisterHtml contains fixture tag, val, bonus, and has NO TV button or tv=1", () => {
    const regPayload: RegisterPagePayload = {
      asOfDate: "2026-10-28",
      generatedAt: "2026-10-28 15:30 (UTC+5)",
      portal: "ft3.bitrix24.kz",
      pultUrl: "https://f3-pult.pages.dev",
      register: fixtureRegisterWithTag
    };

    const regHtml = renderRegisterHtml(regPayload);

    // Contains register test tag
    expect(regHtml).toContain("ТЕСТ-МЕТКА-РЕЕСТРА");
    // Contains val and bonus
    expect(regHtml).toMatch(CYRILLIC_VAL_WORD);
    expect(regHtml).toMatch(CYRILLIC_BONUS_WORD);
    // Standalone container
    expect(regHtml).toContain('id="tab-reg"');
    // Navigation back to pult
    expect(regHtml).toContain('href="./#pult"');
    expect(regHtml).toContain('href="./#ip"');
    expect(regHtml).toContain('href="./#kt"');
    // Footer notice
    expect(regHtml).toContain("Только для руководства · отдельная страница, на ТВ не выводится");

    // ABSOLUTELY NO TV mode controls or handlers on reg page
    expect(regHtml).not.toContain('id="tvBtn"');
    expect(regHtml).not.toContain("tv=1");
    expect(regHtml).not.toContain("toggleTv");
  });

  it("moves periods switch to dateline and keeps period buttons available", () => {
    const html = renderPultHtml(basePayload);
    expect(html).toContain('nav class="periods" id="periodsNav" aria-label="Период"');
    expect(html).toContain('data-p="day"');
    expect(html).toContain('data-p="week"');
    expect(html).toContain('data-p="month"');
  });

  it("keeps TV mode limited strictly to pult scenes, excluding register and market", () => {
    const html = renderPultHtml(basePayload);
    expect(html).toContain('const SCENES = ["month", "sales", "calls", "signals", "tenders"]');
    expect(html).toContain("body.tv .sections");
  });

  it("handles market error gracefully", () => {
    const payloadWithMarketError: SalesPultPayload = {
      ...basePayload,
      market: {
        asOf: "2026-10-28",
        months: [],
        ip: null,
        kt: null,
        error: "Данные рынка ещё собираются."
      }
    };

    const html = renderPultHtml(payloadWithMarketError);
    expect(html).toContain("Данные рынка ещё собираются.");
  });
});
