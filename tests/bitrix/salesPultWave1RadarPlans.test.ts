import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { buildRadarView, parseRadarLotDeal, type RadarRawDeal } from "../../src/bitrix/salesPult/radar/aggregate.js";
import { normalizePlanDeal } from "../../src/bitrix/salesPult/plans/collect.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

function makeLotDeal(overrides: Partial<RadarRawDeal> & { ID: string }): RadarRawDeal {
  return {
    STAGE_ID: "C43:NEW",
    STAGE_SEMANTIC_ID: "P",
    CLOSED: "N",
    ASSIGNED_BY_ID: "s",
    OPPORTUNITY: "4000000",
    ORIGIN_ID: `gz-lot:${overrides.ID}-ЗЦП1`,
    UF_CRM_6627AEBD4503E: "ЗЦП",
    UF_CRM_6627AEBD54B8D: "Интерактивная панель 75",
    UF_CRM_6627AEBD67FFF: "4",
    UF_CRM_6627AEBD72587: "КГУ «Тестовая школа»",
    UF_CRM_6627AEBD85B4D: "Опубликован (прием заявок)",
    COMMENTS: "Статус: Опубликован (прием заявок)",
    ...overrides
  };
}

describe("Radar Almaty UTC+5 boundary in aggregate.ts", () => {
  it("classifies lots right at the Almaty UTC+5 midnight boundary accurately", () => {
    const managerNames = new Map([["s", "Менеджер А"]]);

    // 2026-11-10T23:30:00+05:00 == 2026-11-10T18:30:00Z (same calendar day in UTC and Almaty)
    const asOfDate = "2026-11-10";
    const asOfTimeLate = "2026-11-10T18:30:00Z";

    // Ends 23:59 Almaty same day -> isToday: true, isWithin48h: true
    const endsBeforeMidnight = parseRadarLotDeal(
      makeLotDeal({
        ID: "5001",
        COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-10 23:59 (время Алматы)"
      }),
      { asOfDate, asOfTime: asOfTimeLate, managerNames }
    );
    expect(endsBeforeMidnight).not.toBeNull();
    expect(endsBeforeMidnight?.isToday).toBe(true);
    expect(endsBeforeMidnight?.isWithin48h).toBe(true);
    expect(endsBeforeMidnight?.hoursLeft).toBeCloseTo(29 / 60, 4);

    // Ends exactly at Almaty midnight 2026-11-11 00:00 -> next Almaty day: isToday: false, isWithin48h: true
    const endsAtMidnight = parseRadarLotDeal(
      makeLotDeal({
        ID: "5002",
        COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-11 00:00 (время Алматы)"
      }),
      { asOfDate, asOfTime: asOfTimeLate, managerNames }
    );
    expect(endsAtMidnight).not.toBeNull();
    expect(endsAtMidnight?.isToday).toBe(false);
    expect(endsAtMidnight?.isWithin48h).toBe(true);
    expect(endsAtMidnight?.hoursLeft).toBeCloseTo(0.5, 4);

    // Early morning in Almaty (2026-11-10 01:00+05:00 == 2026-11-09T20:00:00Z in UTC):
    // Lot ending 2026-11-10 23:59 must still be isToday: true!
    const earlyMorningCard = parseRadarLotDeal(
      makeLotDeal({
        ID: "5003",
        COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-10 23:59 (время Алматы)"
      }),
      { asOfDate: "2026-11-10", asOfTime: "2026-11-09T20:00:00Z", managerNames }
    );
    expect(earlyMorningCard).not.toBeNull();
    expect(earlyMorningCard?.isToday).toBe(true);
    expect(earlyMorningCard?.isWithin48h).toBe(true);

    // At exact Almaty midnight 2026-11-11 00:00+05:00 (2026-11-10T19:00:00Z):
    // Lot ending 2026-11-11 00:00 is expired (hoursLeft === 0): not active; the deal is still «Новая», so it is a missed deadline.
    // Lot ending 2026-11-11 18:00 is isToday: true.
    const expiredAtBoundary = parseRadarLotDeal(
      makeLotDeal({
        ID: "5004",
        COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-11 00:00 (время Алматы)"
      }),
      { asOfDate: "2026-11-11", asOfTime: "2026-11-10T19:00:00Z", managerNames }
    );
    expect(expiredAtBoundary?.column).toBe("missed");

    const activeNewDay = parseRadarLotDeal(
      makeLotDeal({
        ID: "5005",
        COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-11 18:00 (время Алматы)"
      }),
      { asOfDate: "2026-11-10", asOfTime: "2026-11-10T19:00:00Z", managerNames }
    );
    expect(activeNewDay).not.toBeNull();
    expect(activeNewDay?.isToday).toBe(true);
    expect(activeNewDay?.hoursLeft).toBeCloseTo(18, 4);
  });
});

function buildWave1Payload(): SalesPultPayload {
  const f = fixture();
  f.payload.portal = "https://f3.bitrix24.kz";

  const managerNames = new Map([
    ["s", "Алия Менеджер"],
    ["t", "Борис Тендеров"]
  ]);
  const asOfDate = "2026-11-10";
  const asOfTime = "2026-11-10T23:30:00+05:00";

  const lotDeals: RadarRawDeal[] = [
    // Today (Almaty 2026-11-10 23:59) - Manager s, ЗЦП, 4M
    makeLotDeal({
      ID: "6101",
      ASSIGNED_BY_ID: "s",
      OPPORTUNITY: "4000000",
      UF_CRM_6627AEBD4503E: "ЗЦП",
      UF_CRM_6627AEBD54B8D: "Панель Интерактивная Alpha",
      UF_CRM_6627AEBD72587: "КГУ «Школа-лицей Альфа» (БИН 010203040506)",
      COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-10 23:59 (время Алматы)\nСтатус: Опубликован (прием заявок)"
    }),
    // Exact Almaty midnight boundary (2026-11-11 00:00 -> within 48h, NOT today) - Manager s, Конкурс, 3M
    makeLotDeal({
      ID: "6102",
      ASSIGNED_BY_ID: "s",
      OPPORTUNITY: "3000000",
      UF_CRM_6627AEBD4503E: "Конкурс",
      UF_CRM_6627AEBD54B8D: "Панель Граничная Beta",
      UF_CRM_6627AEBD72587: "ТОО «Колледж Бета» (БИН 112233445566)",
      COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-11 00:00 (время Алматы)\nСтатус: Опубликован (прием заявок)"
    }),
    // Within 48h (not today) - Manager t, ЗЦП, 5M
    makeLotDeal({
      ID: "6103",
      ASSIGNED_BY_ID: "t",
      OPPORTUNITY: "5000000",
      UF_CRM_6627AEBD4503E: "ЗЦП",
      UF_CRM_6627AEBD54B8D: "Панель Двухдневная Gamma",
      UF_CRM_6627AEBD72587: "КГКП «Гимназия Гамма» (БИН 223344556677)",
      COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-12 10:00 (время Алматы)\nСтатус: Опубликован (прием заявок)"
    }),
    // > 48h (in submitToday, but neither today nor 48h) - Manager t, Конкурс, 6M
    makeLotDeal({
      ID: "6104",
      ASSIGNED_BY_ID: "t",
      OPPORTUNITY: "6000000",
      UF_CRM_6627AEBD4503E: "Конкурс",
      UF_CRM_6627AEBD54B8D: "Панель Дальняя Delta",
      UF_CRM_6627AEBD72587: "КГУ «Университет Дельта» (БИН 334455667788)",
      COMMENTS: "Приём заявок: 2026-11-09 10:00 — 2026-11-14 15:00 (время Алматы)\nСтатус: Опубликован (прием заявок)"
    }),
    // Discussion - Manager s, Конкурс, 2M
    makeLotDeal({
      ID: "6105",
      ASSIGNED_BY_ID: "s",
      OPPORTUNITY: "2000000",
      UF_CRM_6627AEBD4503E: "Конкурс",
      UF_CRM_6627AEBD54B8D: "Доска Обсуждаемая Epsilon",
      UF_CRM_6627AEBD85B4D: "Опубликован",
      COMMENTS: "Приём заявок: 2026-11-15 10:00 — 2026-11-25 18:00 (время Алматы)\nСтатус: Опубликован"
    }),
    // Second chance - Manager t, ЗЦП, 1M
    makeLotDeal({
      ID: "6106",
      ASSIGNED_BY_ID: "t",
      OPPORTUNITY: "1000000",
      UF_CRM_6627AEBD4503E: "ЗЦП",
      UF_CRM_6627AEBD54B8D: "Панель Повторная Zeta",
      UF_CRM_6627AEBD85B4D: "Закупка не состоялась",
      COMMENTS: "Статус: Закупка не состоялась"
    })
  ];

  const radar = buildRadarView({
    lotDeals,
    asOfDate,
    asOfTime,
    portal: f.payload.portal,
    managerNames
  });

  const planDeals = Array.from({ length: 18 }, (_, i) =>
    normalizePlanDeal(
      {
        ID: String(7000 + i + 1),
        CATEGORY_ID: 41,
        ORIGINATOR_ID: "scrape2lead-gz-plans",
        TITLE: `[GZ ${90001 + i}] Тестовая панель ${i + 1}`,
        DATE_CREATE: "2026-11-01",
        CLOSED: "N",
        ASSIGNED_BY_ID: i % 2 === 0 ? "s" : "t",
        UF_CRM_ENSTRU_NAME: i === 5 ? "Интерактивная панель Искомая" : "Интерактивная панель",
        UF_CRM_MONTH: "2026-11",
        UF_CRM_PLAN_STATUS: "Опубликован",
        UF_CRM_6627AEBD4503E: "ЗЦП",
        UF_CRM_COUNT: 5,
        OPPORTUNITY: (i + 1) * 1000000,
        UF_CRM_6627AEBD72587: i === 5 ? "КГУ «Целевой Заказчик Поиска»" : `КГУ «Школа №${i + 1}»`,
        UF_CRM_PLAN_LINK: "https://procurement.gov.kz/plan/1"
      },
      { asOfDate, managerNames }
    )!
  );

  f.payload.plans = buildPlansMonitorView(planDeals, { asOfDate });
  (f.payload as unknown as Record<string, unknown>).radar = radar;
  return f.payload;
}

describe("Wave 1 Browser UI: Radar & Plans", () => {
  it.each([1440, 375])(
    "Radar filters, dynamic counters, Almaty boundary, search cursor/selection & Plans jump on %s px",
    async (width) => {
      const payload = buildWave1Payload();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-wave1-"));
      const file = path.join(dir, "index.html");
      fs.writeFileSync(file, renderPultHtml(payload));

      const page = await browser.newPage({ viewport: { width, height: 812 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("https://fonts.googleapis.com/**", (r) => r.abort());

      try {
        // 1. RADAR
        await page.goto(pathToFileURL(file).href + "#radar-ip");
        const radarTab = page.locator("#tab-radar-ip");
        await expect.poll(() => radarTab.locator(".radar-col").count()).toBe(3);

        // No horizontal overflow
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        const col1Head = radarTab.locator('.radar-col[data-col="submitToday"] h3');
        const col1Cards = radarTab.locator('.radar-col[data-col="submitToday"] .radar-card');
        const todayCounter = radarTab.locator('[data-radar-counter="today"]');
        const h48Counter = radarTab.locator('[data-radar-counter="48h"]');

        // Check two counters: "До конца дня" and "До 48 часов" (explicitly including today)
        expect(await todayCounter.innerText()).toContain("До конца дня");
        expect(await h48Counter.innerText()).toContain("До 48 часов");
        expect(await h48Counter.innerText()).toMatch(/включая сегодня|с учётом сегодняшнего дня/i);

        // Initial (All managers, All methods):
        // submitToday has 4 cards: 6101 (today, 4M), 6102 (boundary 00:00, 3M), 6103 (48h, 5M), 6104 (>48h, 6M)
        // todayCounter: 1 лот, 4,0 млн ₸
        // h48Counter: 3 лота (today 6101 + boundary 6102 + 48h 6103), 12,0 млн ₸
        expect(await col1Head.innerText()).toContain("Все в приёме");
        expect(await col1Cards.count()).toBe(4);
        expect(await todayCounter.innerText()).toContain("1");
        expect(await todayCounter.innerText()).toContain("4,0 млн ₸");
        expect(await h48Counter.innerText()).toContain("3");
        expect(await h48Counter.innerText()).toContain("12,0 млн ₸");

        // Switch timeFilter -> "До 48 ч"
        await radarTab.locator('button[data-radar-time="48h"]').click();
        expect(await col1Head.innerText()).toContain("До 48 часов");
        expect(await col1Cards.count()).toBe(3);
        const ids48h = await col1Cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-deal-id")));
        expect(ids48h).toContain("6101");
        expect(ids48h).toContain("6102"); // exact Almaty midnight 00:00 lot included in 48h
        expect(ids48h).toContain("6103");
        expect(ids48h).not.toContain("6104");

        // Switch timeFilter -> "Сегодня"
        await radarTab.locator('button[data-radar-time="today"]').click();
        expect(await col1Head.innerText()).toContain("Сегодня");
        expect(await col1Cards.count()).toBe(1);
        expect(await col1Cards.first().getAttribute("data-deal-id")).toBe("6101");
        // Almaty midnight 2026-11-11 00:00 lot is NOT in "Сегодня"
        expect(await radarTab.locator('.radar-col[data-col="submitToday"]').innerText()).not.toContain("Панель Граничная Beta");

        // Switch back to "Все в приёме"
        await radarTab.locator('button[data-radar-time="all"]').click();
        expect(await col1Head.innerText()).toContain("Все в приёме");

        // Filter by manager "s" (Алия Менеджер):
        // submitToday for s: 6101 (today, 4M), 6102 (48h boundary, 3M) -> today=1 (4,0M), 48h=2 (7,0M)
        await radarTab.locator('button[data-radar-mgr="s"]').click();
        expect(await todayCounter.innerText()).toContain("1");
        expect(await todayCounter.innerText()).toContain("4,0 млн ₸");
        expect(await h48Counter.innerText()).toContain("2");
        expect(await h48Counter.innerText()).toContain("7,0 млн ₸");
        expect(await col1Cards.count()).toBe(2);

        // Filter by method "Конкурс" while manager "s" is active:
        // submitToday for s + Конкурс: only 6102 (48h boundary, 3M) -> today=0 (0,0M), 48h=1 (3,0M)
        await radarTab.locator('button[data-radar-method="Конкурс"]').click();
        expect(await todayCounter.innerText()).toContain("0");
        expect(await todayCounter.innerText()).toContain("0,0 млн ₸");
        expect(await h48Counter.innerText()).toContain("1");
        expect(await h48Counter.innerText()).toContain("3,0 млн ₸");
        expect(await col1Cards.count()).toBe(1);
        expect(await col1Cards.first().getAttribute("data-deal-id")).toBe("6102");

        // Switch timeFilter to "Сегодня" -> zero results in col 1!
        await radarTab.locator('button[data-radar-time="today"]').click();
        expect(await col1Cards.count()).toBe(0);
        expect(await radarTab.locator('.radar-col[data-col="submitToday"]').innerText()).toContain("Нет закупок");

        // Reset filters back to all
        await radarTab.locator('button[data-radar-mgr=""]').click();
        await radarTab.locator('button[data-radar-method=""]').click();
        await radarTab.locator('button[data-radar-time="all"]').click();

        // Zero results via search query
        const searchInput = radarTab.locator(".radar-search-input");
        await searchInput.fill("несуществующий-запрос-999");
        expect(await radarTab.locator(".radar-card").count()).toBe(0);
        expect(await radarTab.locator('.radar-col[data-col="submitToday"]').innerText()).toContain("Нет закупок");
        expect(await radarTab.locator('.radar-col[data-col="discussion"]').innerText()).toContain("Нет закупок");
        expect(await radarTab.locator('.radar-col[data-col="secondChance"]').innerText()).toContain("Нет закупок");

        // Search editing: typing x and y before "ab" must produce "xyab"
        await searchInput.fill("ab");
        await searchInput.evaluate((el: HTMLInputElement) => {
          el.focus();
          el.setSelectionRange(0, 0);
        });
        await page.keyboard.type("x");
        await page.keyboard.type("y");
        expect(await searchInput.inputValue()).toBe("xyab");
        const cursorAfterInsert = await searchInput.evaluate((el: HTMLInputElement) => ({
          start: el.selectionStart,
          end: el.selectionEnd
        }));
        expect(cursorAfterInsert).toEqual({ start: 2, end: 2 });

        // Selection preservation when re-rendering and editing selection
        await searchInput.evaluate((el: HTMLInputElement) => {
          el.setSelectionRange(1, 3, "backward");
        });
        const selBefore = await searchInput.evaluate((el: HTMLInputElement) => ({
          start: el.selectionStart,
          end: el.selectionEnd,
          dir: el.selectionDirection
        }));
        expect(selBefore).toEqual({ start: 1, end: 3, dir: "backward" });

        // Trigger full __renderRadarTab while input is focused with selection -> must preserve selectionStart/End/Direction
        await page.evaluate(() => {
          const pane = document.getElementById("tab-radar-ip");
          const radar = (0, eval)("PAYLOAD.radar");
          (window as unknown as { __renderRadarTab: (t: string, r: unknown, c: HTMLElement | null) => void })
            .__renderRadarTab("radar-ip", radar, pane);
        });
        const selAfterRerender = await searchInput.evaluate((el: HTMLInputElement) => ({
          focused: document.activeElement === el,
          start: el.selectionStart,
          end: el.selectionEnd,
          dir: el.selectionDirection
        }));
        expect(selAfterRerender).toEqual({ focused: true, start: 1, end: 3, dir: "backward" });

        // Replacing selected range [1, 3] ("ya") with "Z" gives "xZb"
        await page.keyboard.type("Z");
        expect(await searchInput.inputValue()).toBe("xZb");

        // Changing global "Я — …" (#meSelect) updates Radar manager filter and counters dynamically
        await page.locator("#meSelect").selectOption("t");
        expect(await todayCounter.innerText()).toContain("0");
        expect(await h48Counter.innerText()).toContain("1");
        expect(await h48Counter.innerText()).toContain("5,0 млн ₸");
        await page.locator("#meSelect").selectOption("");

        // 2. PLANS: "Найти открытый план" keyboard jump, focus & sticky header clearance
        await page.goto(pathToFileURL(file).href + "#plans-ip");
        const plansTab = page.locator("#tab-plans-ip");
        const findOpenBtn = plansTab.locator(".plans-summary [data-plan-find-open]");
        await expect.poll(() => findOpenBtn.count()).toBe(1);
        expect(await findOpenBtn.innerText()).toContain("Найти открытый план");

        // No horizontal overflow in Plans
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        // Activate button from keyboard (focus + Enter)
        await findOpenBtn.focus();
        expect(await findOpenBtn.evaluate((el) => document.activeElement === el)).toBe(true);
        await page.keyboard.press("Enter");

        const planSearch = plansTab.locator(".plan-search-input");
        const geometry = await planSearch.evaluate((el) => {
          const inputRect = el.getBoundingClientRect();
          const barRect = document.querySelector(".bar")!.getBoundingClientRect();
          const datelineRect = document.querySelector(".dateline")!.getBoundingClientRect();
          const openRect = el.closest(".plans-open")!.getBoundingClientRect();
          return {
            focused: document.activeElement === el,
            inputTop: inputRect.top,
            inputBottom: inputRect.bottom,
            openTop: openRect.top,
            barBottom: barRect.bottom,
            datelineBottom: datelineRect.bottom,
            viewportHeight: window.innerHeight
          };
        });

        expect(geometry.focused).toBe(true);
        expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.barBottom);
        expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.datelineBottom);
        expect(geometry.openTop).toBeGreaterThanOrEqual(geometry.barBottom);
        expect(geometry.openTop).toBeGreaterThanOrEqual(geometry.datelineBottom);
        expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.viewportHeight);

        // Typing immediately into focused search filters open plans
        await page.keyboard.type("Целевой Заказчик");
        expect(await plansTab.locator(".plans-table [data-plan-id]").count()).toBe(1);

        expect(errors).toEqual([]);
      } finally {
        await page.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    60000
  );
});
