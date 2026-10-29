import { describe, it, expect } from "vitest";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";
import fs from "node:fs";

describe("salesPult tabs rendering", () => {
  const basePayload: SalesPultPayload = JSON.parse(
    fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8")
  );

  it("renders header sections navigation with 4 tabs", () => {
    const html = renderPultHtml(basePayload);

    expect(html).toContain('nav class="sections" aria-label="Разделы"');
    expect(html).toContain('href="#pult" data-t="pult"');
    expect(html).toContain('href="#reg" data-t="reg"');
    expect(html).toContain('href="#ip" data-t="ip"');
    expect(html).toContain('href="#kt" data-t="kt"');

    // 4 tab containers
    expect(html).toContain('id="tab-pult"');
    expect(html).toContain('id="tab-reg"');
    expect(html).toContain('id="tab-ip"');
    expect(html).toContain('id="tab-kt"');
  });

  it("moves periods switch to dateline and hides on non-pult tabs", () => {
    const html = renderPultHtml(basePayload);
    expect(html).toContain('nav class="periods" id="periodsNav" aria-label="Период"');
    // Period buttons remain available
    expect(html).toContain('data-p="day"');
    expect(html).toContain('data-p="week"');
    expect(html).toContain('data-p="month"');
  });

  it("keeps TV mode limited strictly to pult scenes, excluding register and market", () => {
    const html = renderPultHtml(basePayload);
    // SCENES definition in client js should only contain pult blocks
    expect(html).toContain('const SCENES = ["month", "sales", "calls", "signals", "tenders"]');
    // TV mode hides sections navigation
    expect(html).toContain("body.tv .sections");
  });

  it("handles missing register and market data gracefully", () => {
    const payloadWithoutExtras: SalesPultPayload = {
      ...basePayload,
      register: null,
      market: null
    };

    const html = renderPultHtml(payloadWithoutExtras);
    expect(html).toBeDefined();
    expect(html).toContain('"register":null');
    expect(html).toContain('"market":null');
  });

  it("handles register and market errors gracefully", () => {
    const payloadWithErrors: SalesPultPayload = {
      ...basePayload,
      register: {
        file: "",
        asOf: "",
        month: "",
        total: { sale: 0, val: 0, bonusMop: 0, bonusRop: 0, contracts: 0, plan: 0, b2bPlan: 0, b2bSale: 0 },
        daily: [],
        managers: [],
        mix: [],
        channels: [],
        groups: [],
        missing: [],
        crmExtra: 0,
        rows: [],
        error: "Реестр не подключён: папка на Диске не найдена"
      },
      market: {
        asOf: "",
        months: [],
        "ИП": null,
        "КТ": null,
        error: "Данные рынка ещё собираются."
      }
    };

    const html = renderPultHtml(payloadWithErrors);
    expect(html).toContain("Реестр не подключён: папка на Диске не найдена");
    expect(html).toContain("Данные рынка ещё собираются.");
  });
});
