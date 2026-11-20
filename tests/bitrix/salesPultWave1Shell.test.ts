import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { attachRegisterContracts } from "../../src/bitrix/salesPult/contracts.js";
import { renderPultHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { buildMarketGroupView } from "../../src/kz/market/aggregate.js";
import { loadMarketConfig } from "../../src/kz/market/config.js";
import type { MarketUnit } from "../../src/kz/market/types.js";
import type { SalesPultPayload } from "../../src/bitrix/salesPult/types.js";

vi.setConfig({ testTimeout: 30_000 });

function buildSamplePayload(): {
  payload: SalesPultPayload;
  reg: RegisterPagePayload;
  aliases: Record<string, string>;
} {
  const f = fixture();
  f.payload.asOfDate = "2026-10-29";
  f.payload.generatedAt = "2026-10-29 14:30 (UTC+5)";
  attachRegisterContracts(f.payload, f.register, f.deals, f.aliases);

  const cfg = loadMarketConfig();
  const sampleUnits: MarketUnit[] = [
    {
      id: 1,
      month: "2026-09",
      date: "2026-09-15",
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 50000000,
      qty: 50,
      price: 1000000,
      supplier: "061140003942",
      customer: "111111111111",
      supplierName: 'ТОО "F3.kz"',
      customerName: "Тестовый заказчик 1",
      method: "Открытый конкурс",
      us: true
    },
    {
      id: 2,
      month: "2026-10",
      date: "2026-10-10",
      group: "ИП",
      code: "262030.100.000021",
      kind: "Интерактивные панели",
      sum: 80000000,
      qty: 80,
      price: 1000000,
      supplier: "061140003942",
      customer: "111111111111",
      supplierName: 'ТОО "F3.kz"',
      customerName: "Тестовый заказчик 1",
      method: "Открытый конкурс",
      us: true
    }
  ];

  f.payload.market = {
    educationPending: {},
    asOf: "2026-10-29",
    months: ["2026-09", "2026-10"],
    ip: buildMarketGroupView("ИП", sampleUnits, "2026-10-29", cfg),
    kt: buildMarketGroupView("КТ", sampleUnits, "2026-10-29", cfg),
    updatedAt: "2026-10-29"
  };

  // Алия ("s") имеет срочную ошибку CRM и сигналы; Борис ("t") — не имеет срочных пунктов.
  if (f.payload.contractSource) {
    f.payload.contractSource.signals = f.payload.contractSource.signals.filter(
      (sig) => !sig.text.includes("Борис")
    );
  }
  f.payload.outcomeMismatches = [
    {
      id: "701",
      title: "Выдуманная сделка 1",
      amount: 1000,
      managerId: "s",
      managerName: "Алия Тестовая",
      outcome: "won:000000000001/1"
    }
  ];

  // Запас задач/долгов, чтобы страница прокручивалась до #signals на 1440 и 375 px.
  f.payload.groups[0].managers[0].topTasks = Array.from({ length: 4 }, (_, i) => ({
    id: `t-${i + 1}`,
    dealId: `90${i + 1}`,
    title: `Выдуманная задача ${i + 1}`,
    deadline: "2026-10-28",
    amount: 50000,
    isOverdue: true,
    overdueDays: 2,
    rank: i + 1,
    kind: "overdue" as const,
    group: 1 as const
  }));

  const closed = structuredClone(f.payload);
  closed.closedMonth = true;
  closed.asOfDate = "2026-09-30";
  closed.generatedAt = "2026-09-30 23:59 (UTC+5)";
  closed.closedMonths = undefined;
  f.payload.closedMonths = { "2026-09": closed };

  const reg: RegisterPagePayload = {
    asOfDate: f.payload.asOfDate,
    generatedAt: f.payload.generatedAt,
    portal: f.payload.portal,
    register: f.register,
    reconciliation: f.payload.contractSource?.reconciliation
  };
  return { payload: f.payload, reg, aliases: f.aliases };
}

describe("wave 1 shell: urgent jump & TV mode URL state", () => {
  let browser: Browser;
  let server: http.Server;
  let baseUrl: string;
  let tempDir: string;
  const routes = new Map<string, string>();

  beforeAll(async () => {
    const sample = buildSamplePayload();
    const emptyPayload = structuredClone(sample.payload);
    emptyPayload.outcomeMismatches = [];
    if (emptyPayload.contractSource) {
      emptyPayload.contractSource.signals = [];
    }

    const viewerAliya = renderManagerVariant(
      buildManagerVariant({
        pult: sample.payload,
        reg: sample.reg,
        planDeals: [],
        managerId: "s",
        aliases: sample.aliases
      })!
    );
    const viewerBoris = renderManagerVariant(
      buildManagerVariant({
        pult: sample.payload,
        reg: sample.reg,
        planDeals: [],
        managerId: "t",
        aliases: sample.aliases
      })!
    );

    routes.set("/index.html", renderPultHtml(sample.payload));
    routes.set("/empty.html", renderPultHtml(emptyPayload));
    routes.set("/viewer-urgent.html", viewerAliya.index);
    routes.set("/viewer-clean.html", viewerBoris.index);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-wave1-shell-"));
    fs.writeFileSync(path.join(tempDir, "index.html"), routes.get("/index.html")!, "utf8");

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      const html = routes.get(reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname);
      if (!html) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  for (const width of [1440, 375]) {
    it(`jumps from #month to #signals via keyboard without sticky overlap at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(`${baseUrl}/index.html#pult`);
        const btn = page.locator("#urgentJumpBtn");
        expect(await btn.isVisible()).toBe(true);
        expect(await btn.innerText()).toContain("К срочному");

        await btn.focus();
        await page.keyboard.press("Enter");

        await page.waitForFunction(() => window.scrollY > 0);
        const geom = await page.evaluate(() => {
          const bar = document.querySelector(".bar")!.getBoundingClientRect();
          const dateline = document.querySelector(".dateline")!.getBoundingClientRect();
          const signals = document.getElementById("signals")!.getBoundingClientRect();
          const heading = document.querySelector("#signals h2")!.getBoundingClientRect();
          return {
            stickyBottom: Math.max(bar.bottom, dateline.bottom),
            signalsTop: signals.top,
            headingTop: heading.top,
            overflow: document.documentElement.scrollWidth > innerWidth
          };
        });
        expect(geom.overflow).toBe(false);
        expect(geom.signalsTop).toBeGreaterThanOrEqual(geom.stickyBottom - 1);
        expect(geom.headingTop).toBeGreaterThanOrEqual(geom.stickyBottom - 1);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });

    it(`hides urgent jump when no urgent items, in myMgr without urgent items, closed month, and TV at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        // 1. Нет срочных пунктов вообще -> «Срочного нет», ссылки нет.
        await page.goto(`${baseUrl}/empty.html#pult`);
        expect(await page.locator("#signals").innerText()).toContain("Срочного нет");
        expect(await page.locator("#urgentJumpBtn").count()).toBe(0);

        // 2. Режим «Я — ...» на полной странице: у Бориса ("t") нет срочных пунктов -> «У вас нет срочных пунктов», перехода нет.
        await page.goto(`${baseUrl}/index.html#pult`);
        expect(await page.locator("#urgentJumpBtn").count()).toBe(1);
        await page.selectOption("#meSelect", "t");
        expect(await page.locator("#signals").innerText()).toContain("У вас нет срочных пунктов");
        expect(await page.locator("#urgentJumpBtn").count()).toBe(0);

        // У Алии ("s") есть срочный пункт -> переход появляется.
        await page.selectOption("#meSelect", "s");
        expect(await page.locator("#urgentJumpBtn").count()).toBe(1);

        // 3. Закрытый месяц -> #signals скрыт, перехода нет.
        await page.selectOption("#monthSelect", "2026-09");
        expect(await page.locator("#signals").isVisible()).toBe(false);
        expect(await page.locator("#urgentJumpBtn").count()).toBe(0);

        // Возврат на текущий месяц -> переход снова появляется.
        await page.selectOption("#monthSelect", "2026-10");
        expect(await page.locator("#urgentJumpBtn").count()).toBe(1);

        // 4. ТВ-режим -> перехода нет.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.keyboard.press("t");
        expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
        expect(await page.locator("#urgentJumpBtn").count()).toBe(0);

        await page.keyboard.press("t");
        expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
        expect(await page.locator("#urgentJumpBtn").count()).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });

    it(`respects viewer role for urgent jump and TV mode at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        // Viewer без срочных пунктов (Борис) -> перехода нет.
        await page.goto(`${baseUrl}/viewer-clean.html`);
        expect(await page.locator("#signals").innerText()).toContain("У вас нет срочных пунктов");
        expect(await page.locator("#urgentJumpBtn").count()).toBe(0);

        // Viewer со срочными пунктами (Алия) -> переход есть и работает с клавиатуры.
        await page.goto(`${baseUrl}/viewer-urgent.html`);
        expect(await page.locator("#urgentJumpBtn").count()).toBe(1);
        await page.locator("#urgentJumpBtn").focus();
        await page.keyboard.press("Space");
        await page.waitForFunction(() => window.scrollY > 0);

        // Вход в ТВ по клавише T сохраняет ?tv=1, выход возвращает viewer на #pult без ?tv=1 и без доступа к #radar-ip.
        await page.keyboard.press("t");
        expect(new URL(page.url()).searchParams.get("tv")).toBe("1");
        expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
        await page.reload();
        expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
        await page.keyboard.press("t");
        expect(new URL(page.url()).searchParams.get("tv")).toBeNull();
        expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
        expect(await page.locator("#meSelect").isDisabled()).toBe(true);
        expect(await page.locator("#urgentJumpBtn").count()).toBe(1);

        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }

  it("persists TV mode via ?tv=1 across reload, restores preTvTab/hash/month/period on exit via button, T, and direct link", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      // 1. Вход с вкладки «Рынок» (#ip/2026-09) кнопкой ТВ -> перезагрузка -> выход кнопкой.
      await page.goto(`${baseUrl}/index.html#ip/2026-09`);
      expect(await page.locator("#tab-ip").getAttribute("class")).toContain("on");

      await page.locator("#tvBtn").click();
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      expect(new URL(page.url()).searchParams.get("tv")).toBe("1");
      expect(new URL(page.url()).hash).toBe("#ip/2026-09");
      expect(await page.locator("#tab-pult").getAttribute("class")).toContain("on");

      await page.reload();
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      expect(new URL(page.url()).searchParams.get("tv")).toBe("1");
      expect(await page.locator("#tab-pult").getAttribute("class")).toContain("on");

      await page.locator("#tvBtn").click();
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
      expect(new URL(page.url()).searchParams.get("tv")).toBeNull();
      expect(new URL(page.url()).hash).toBe("#ip/2026-09");
      expect(await page.locator("#tab-ip").getAttribute("class")).toContain("on");
      expect(await page.locator('#marketMonths button[data-month="2026-09"]').getAttribute("aria-pressed")).toBe("true");

      // Перезагрузка после выхода — остаётся обычный режим и вкладка #ip/2026-09.
      await page.reload();
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
      expect(await page.locator("#tab-ip").getAttribute("class")).toContain("on");
      expect(await page.locator('#marketMonths button[data-month="2026-09"]').getAttribute("aria-pressed")).toBe("true");

      // 2. Вход с закрытого месяца (#pult/2026-09) клавишей T -> ТВ показывает текущий месяц -> выход восстанавливает закрытый месяц.
      await page.goto(`${baseUrl}/index.html#pult/2026-09`);
      expect(await page.locator("#month h2").textContent()).toContain("Сентябрь");
      await page.keyboard.press("t");
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      expect(await page.locator("#month h2").textContent()).toContain("Октябрь");
      expect(new URL(page.url()).searchParams.get("tv")).toBe("1");
      await page.reload();
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      expect(await page.locator("#month h2").textContent()).toContain("Октябрь");
      await page.keyboard.press("t");
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
      expect(new URL(page.url()).searchParams.get("tv")).toBeNull();
      expect(new URL(page.url()).hash).toBe("#pult/2026-09");
      expect(await page.locator("#month h2").textContent()).toContain("Сентябрь");

      // 3. Сохранение выбранного периода («Неделя») при входе/выходе из ТВ.
      await page.selectOption("#monthSelect", "2026-10");
      await page.locator('#periodsNav button[data-p="week"]').click();
      expect(await page.locator('#periodsNav button[data-p="week"]').getAttribute("aria-pressed")).toBe("true");
      await page.keyboard.press("t");
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      await page.keyboard.press("t");
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
      expect(await page.locator('#periodsNav button[data-p="week"]').getAttribute("aria-pressed")).toBe("true");

      // 4. Прямая ссылка ?tv=1 на старте + hashchange во время ТВ.
      await page.goto(`${baseUrl}/index.html?tv=1`);
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      await page.evaluate(() => { location.hash = "#ip/2026-09"; });
      await page.waitForTimeout(100);
      // В ТВ активной остаётся сцена пульта.
      expect(await page.locator("#tab-pult").getAttribute("class")).toContain("on");
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(true);
      // При выходе открывается выбранный через hashchange раздел.
      await page.locator("#tvBtn").click();
      expect(new URL(page.url()).searchParams.get("tv")).toBeNull();
      expect(await page.locator("#tab-ip").getAttribute("class")).toContain("on");
      expect(new URL(page.url()).hash).toBe("#ip/2026-09");

      // 5. Нажатие T внутри поля ввода или с Ctrl/Meta не переключает ТВ.
      await page.locator("#searchBtn").click();
      await page.locator("#quickSearchInput").press("t");
      expect(await page.evaluate(() => document.body.classList.contains("tv"))).toBe(false);
      await page.keyboard.press("Escape");

      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
