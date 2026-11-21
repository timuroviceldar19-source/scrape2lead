import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { renderPultHtml } from "../../src/bitrix/salesPult/site.js";
import { computeRadarKpis } from "../../src/bitrix/salesPult/radar/aggregate.js";
import { buildStockAvailability, withStockHints } from "../../src/bitrix/salesPult/stock/availability.js";
import { buildPlansMonitorView } from "../../src/bitrix/salesPult/plans/aggregate.js";
import { pulseForPayload, lossPulseItems, stockDemandPulseItems } from "../../src/bitrix/salesPult/pulse.js";
import { buildStockDemand } from "../../src/bitrix/salesPult/stock/availability.js";
import { summarizeRecentCheaperRejections } from "../../src/kz/competitors/losses.js";
import type { RadarView } from "../../src/bitrix/salesPult/radar/types.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { radarMissedView } from "../fixtures/sales-pult/radarMissed.js";
import { stockFinance, stockPlanDeals, stockRadar } from "../fixtures/sales-pult/stock.js";
import { buildLossesSampleView } from "../fixtures/kz/competitorsLosses.js";

// Сводная проверка раскладки после слияния пунктов 1–4 (все данные выдуманные):
// - строки лотов внутри таблиц «Конкурентов» не получают сетку таблицы (дата не режется до 28 px);
// - бейджи сроков Радара и теги склада читаются: контраст текста не ниже 4,5:1.

const AS_OF = "2026-11-21";
let browser: Browser;
let file: string;

function radar(): RadarView {
  const missed = radarMissedView();
  const extra = stockRadar();
  const out = { asOf: AS_OF, ip: { ...missed.ip }, kt: { ...missed.kt } } as RadarView;
  for (const g of ["ip", "kt"] as const) {
    for (const col of ["submitToday", "discussion", "secondChance", "missed"] as const) {
      out[g][col] = [...(missed[g][col] ?? []), ...(extra[g][col] ?? [])];
    }
    out[g].kpis = computeRadarKpis(out[g]);
  }
  return out;
}

beforeAll(async () => {
  const f = fixture();
  const p = f.payload;
  p.asOfDate = AS_OF;
  p.generatedAt = "2026-11-21 09:49 (UTC+5)";
  p.radar = radar();
  p.plans = buildPlansMonitorView(stockPlanDeals(), { asOfDate: AS_OF });
  p.competitors = buildLossesSampleView(AS_OF);
  const stock = buildStockAvailability(stockFinance("2026-11-20"), AS_OF);
  p.stock = stock && withStockHints(stock, p.radar, p.plans);
  p.pulse = pulseForPayload(p, {
    nowIso: "2026-11-21T09:49:30+05:00", finance: stockFinance("2026-11-20"), register: f.register,
    extraItems: [
      ...lossPulseItems(summarizeRecentCheaperRejections(p.competitors, AS_OF)),
      ...stockDemandPulseItems(p.stock, buildStockDemand(stock, p.radar, p.plans))
    ]
  });
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pult-decision-")), "index.html");
  fs.writeFileSync(file, renderPultHtml(p));
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });

async function open(hash: string, width: number) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${pathToFileURL(file).href}${hash}`);
  await page.waitForTimeout(400);
  return { page, errors };
}

describe("раскладка после слияния пунктов 1–4", () => {
  for (const width of [375, 1440]) {
    it(`«Конкуренты»: даты в строках лотов не обрезаны; ${width} px`, async () => {
      const { page, errors } = await open("#competitors-ip", width);
      try {
        // раскрыть все списки, чтобы строки лотов были видимы
        await page.evaluate(() => document.querySelectorAll("#tab-competitors-ip details").forEach((d) => { (d as HTMLDetailsElement).open = true; }));
        await page.waitForTimeout(100);
        const clipped = await page.evaluate(() => [...document.querySelectorAll("#tab-competitors-ip .num")]
          .filter((e) => (e as HTMLElement).offsetParent && e.scrollWidth > e.clientWidth + 1)
          .map((e) => `${e.parentElement?.className}: ${e.textContent}`));
        expect(clipped).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }, 30000);
  }

  it("пульс на телефоне 375 px: заголовки и детали переносятся, а не обрезаются многоточием", async () => {
    const { page, errors } = await open("#pult", 375);
    try {
      const rows = await page.evaluate(() => [...document.querySelectorAll("#pulse .pulse-title, #pulse .pulse-meta")]
        .map((e) => ({ text: e.textContent ?? "", cut: e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === "ellipsis" && getComputedStyle(e).whiteSpace === "nowrap" })));
      expect(rows.length).toBeGreaterThanOrEqual(8);
      expect(rows.filter((r) => r.cut).map((r) => r.text)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);

  it("бейджи сроков Радара и теги склада: контраст текста не ниже 4,5:1", async () => {
    const { page, errors } = await open("#radar-ip", 1440);
    try {
      const ratios = await page.evaluate(() => {
        const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return [...document.querySelectorAll("#tab-radar-ip .radar-badge, #tab-radar-ip .stock-tag")]
          .filter((el) => (el as HTMLElement).offsetParent)
          .map((el) => {
            let n: Element | null = el; let bg = "rgba(0, 0, 0, 0)";
            while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; }
            const a = lum(rgb(getComputedStyle(el).color)); const b = lum(rgb(bg));
            return { cls: el.className, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
          });
      });
      expect(ratios.length).toBeGreaterThan(3);
      expect(ratios.some((r) => r.cls.includes("stock-tag"))).toBe(true);
      for (const r of ratios) expect(r.ratio, r.cls).toBeGreaterThanOrEqual(4.5);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
