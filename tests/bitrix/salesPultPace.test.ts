import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  calculatePace,
  calculateMonthForecast,
  judgeMetricStatus,
  buildPultSignals,
  buildCallNotes,
  buildPultView,
  decodeHtmlEntities,
  plural,
  formatMoney,
  getMonthWorkDays,
  isWorkDay,
  cleanTaskTitle,
  getTaskStatus,
  DEFAULT_HOLIDAYS
} from "../../src/bitrix/salesPult/pace.js";
import { renderPultHtml, type SalesPultPayload } from "../../src/bitrix/salesPult/site.js";

describe("salesPultPace", () => {
  describe("October 2026 working days, pace and forecast", () => {
    it("has 21 working days in October 2026 with 26.10 as holiday", () => {
      expect(isWorkDay(2026, 10, 26, DEFAULT_HOLIDAYS)).toBe(false);
      const workDays = getMonthWorkDays(2026, 10, DEFAULT_HOLIDAYS);
      expect(workDays.length).toBe(21);
      expect(workDays).not.toContain(26); // Monday 26.10 is holiday
      expect(workDays).not.toContain(25); // Sunday 25.10 is weekend
      expect(workDays).toContain(27);
      expect(workDays).toContain(28);
      expect(workDays).toContain(29);
      expect(workDays).toContain(30);
    });

    it("calculates correct month pace at 06:00 on 2026-10-29", () => {
      const paceCtx = calculatePace("2026-10-29", "2026-10-29 06:00 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(paceCtx.monthTotal).toBe(21);
      expect(paceCtx.wdBefore).toBe(19);
      expect(paceCtx.todayIsWork).toBe(true);
      expect(paceCtx.isEarly).toBe(true);
      expect(paceCtx.dayFrac).toBe(0); // Before 09:00
      expect(paceCtx.monthDone).toBe(19);
      expect(paceCtx.pace.month).toBeCloseTo(19 / 21, 4);
    });

    it("calculates correct month pace in the middle of workday at 15:00 on 2026-10-29", () => {
      const paceCtx = calculatePace("2026-10-29", "2026-10-29 15:00 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(paceCtx.isEarly).toBe(false);
      // (15 - 9) / 9 = 6 / 9 = 2/3
      expect(paceCtx.dayFrac).toBeCloseTo(2 / 3, 4);
      // Fractional monthDone includes today's dayFrac
      expect(paceCtx.monthDone).toBeCloseTo(19 + 2 / 3, 4);
      expect(paceCtx.pace.month).toBeCloseTo((19 + 2 / 3) / 21, 4);
    });

    it("calculates fractional monthDone and integer label N = Math.floor(monthDone)", () => {
      // 29.10 15:10 → monthDone ≈ 19,69, подпись 19
      const cMid = calculatePace("2026-10-29", "2026-10-29 15:10 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(cMid.monthDone).toBeCloseTo(19.685, 2);
      expect(Math.floor(cMid.monthDone)).toBe(19);

      // 30.10 08:00 → 20
      const c1 = calculatePace("2026-10-30", "2026-10-30 08:00 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(c1.monthDone).toBe(20);
      expect(Math.floor(c1.monthDone)).toBe(20);

      // 30.10 19:00 → 21
      const c2 = calculatePace("2026-10-30", "2026-10-30 19:00 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(c2.monthDone).toBe(21);
      expect(Math.floor(c2.monthDone)).toBe(21);

      // 31.10 12:00 → 21 (weekend)
      const c3 = calculatePace("2026-10-31", "2026-10-31 12:00 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(c3.monthDone).toBe(21);
      expect(Math.floor(c3.monthDone)).toBe(21);
    });

    it("forecasts within 168 ± 2 at steady 8 contracts/day on 06.10 15:00 and 29.10 15:10", () => {
      // 06.10 15:00: 3 days before, dayFrac 6/9 = 2/3 -> monthDone = 3.6667
      const p1 = calculatePace("2026-10-06", "2026-10-06 15:00 (UTC+5)", DEFAULT_HOLIDAYS);
      expect(p1.monthDone).toBeCloseTo(3 + 2 / 3, 4);
      const fact1 = 8 * p1.monthDone;
      const res1 = calculateMonthForecast(168, fact1, p1.monthDone, 21);
      expect(res1.forecast).toBeGreaterThanOrEqual(166);
      expect(res1.forecast).toBeLessThanOrEqual(170);

      // 29.10 15:10: 19 days before, dayFrac ~0.685 -> monthDone = 19.685
      const p2 = calculatePace("2026-10-29", "2026-10-29 15:10 (UTC+5)", DEFAULT_HOLIDAYS);
      const fact2 = 8 * p2.monthDone;
      const res2 = calculateMonthForecast(168, fact2, p2.monthDone, 21);
      expect(res2.forecast).toBeGreaterThanOrEqual(166);
      expect(res2.forecast).toBeLessThanOrEqual(170);
    });

    it("calculates forecast, left to plan, and daily need accurately", () => {
      // 19 days done out of 21, 38 signed, plan is 45
      const res = calculateMonthForecast(45, 38, 19, 21);
      expect(res.pacePerDay).toBe(2.0); // 38 / 19
      expect(res.daysLeft).toBe(2); // 21 - 19
      expect(res.forecast).toBe(42); // 38 + 2 * 2
      expect(res.left).toBe(7); // 45 - 38
      expect(res.need).toBe(3.5); // 7 / 2
      expect(res.fpct).toBe(93); // Math.round((42 / 45) * 100)
      expect(res.verdict).toContain("≈ 42 из 45");
      expect(res.verdict).toContain("3,5 в день");
      expect(res.verdict).toContain("вместо 2,0");
    });

    it("handles plan fulfilled scenario in verdict", () => {
      const res = calculateMonthForecast(40, 42, 19, 21);
      expect(res.left).toBe(0);
      expect(res.verdict).toContain("План месяца <b>выполнен</b>");

      const resZeroLeft = calculateMonthForecast(180, 180, 21, 21);
      expect(resZeroLeft.verdict).toContain("План месяца <b>выполнен</b>");
    });

    it("handles on-track scenario in verdict when forecast meets plan", () => {
      const res = calculateMonthForecast(40, 38, 19, 21);
      expect(res.forecast).toBe(42);
      expect(res.verdict).toContain("Идём в темпе");
      expect(res.verdict).toContain("план закроем");
    });

    it("outputs 'Месяц только начался' when 0 or 1 working days passed (less than 3)", () => {
      // 0 days passed: left = 160, daysLeft = 21 -> 160 / 21 ≈ 7.6
      const res0 = calculateMonthForecast(160, 0, 0, 21);
      expect(res0.hasForecast).toBe(false);
      expect(res0.verdict).toBe("Месяц только начался. Чтобы закрыть план, нужно 7,6 договора в рабочий день.");

      // 1 day passed: left = 158, daysLeft = 20 -> 158 / 20 = 7.9
      const res1 = calculateMonthForecast(160, 2, 1, 21);
      expect(res1.hasForecast).toBe(false);
      expect(res1.verdict).toBe("Месяц только начался. Чтобы закрыть план, нужно 7,9 договора в рабочий день.");
    });

    it("calculates daily need in 'Месяц только начался' with lag (3 of 180 at monthDone 2 -> 9,3 договора)", () => {
      // left = 177, daysLeft = 19 -> 177 / 19 ≈ 9.3157... -> 9,3 договора
      const res = calculateMonthForecast(180, 3, 2, 21);
      expect(res.hasForecast).toBe(false);
      expect(res.daysLeft).toBe(19);
      expect(res.verdict).toBe("Месяц только начался. Чтобы закрыть план, нужно 9,3 договора в рабочий день.");
    });

    it("outputs normal phrase when 10 days left and 45 contracts of 180 (daysLeft > 5)", () => {
      const res = calculateMonthForecast(180, 45, 11, 21);
      expect(res.daysLeft).toBe(10);
      expect(res.hasForecast).toBe(true);
      expect(res.verdict).toContain("При нынешнем темпе к концу месяца будет");
      expect(res.verdict).not.toContain("уже не закрыть");
    });

    it("outputs 'уже не закрыть' when 2 days left and 87 of 180 contracts (daysLeft <= 5 and need > 2*pace)", () => {
      const res = calculateMonthForecast(180, 87, 19, 21);
      expect(res.daysLeft).toBe(2);
      expect(res.hasForecast).toBe(true);
      expect(res.verdict).toBe("План месяца уже не закрыть: осталось 93 договора за 2 рабочих дня.");
    });

    it("handles 30.10 15:00 (87 of 180) as 'уже не закрыть … за 1 рабочий день' and 19:00 as 'Рабочие дни закончились'", () => {
      // 30.10 15:00: monthDone = 20 + 2/3, daysLeft = 1/3, Math.ceil(daysLeft) = 1
      const res15 = calculateMonthForecast(180, 87, 20 + 2 / 3, 21);
      expect(res15.daysLeft).toBeCloseTo(1 / 3, 4);
      expect(Math.ceil(res15.daysLeft)).toBe(1);
      expect(res15.verdict).toBe("План месяца уже не закрыть: осталось 93 договора за 1 рабочий день.");

      // 30.10 19:00: monthDone = 21, daysLeft = 0
      const res19 = calculateMonthForecast(180, 87, 21, 21);
      expect(res19.daysLeft).toBe(0);
      expect(res19.verdict).toBe("Рабочие дни месяца закончились: подписано 87 из 180, это 48% плана.");
    });

    it("outputs 'Рабочие дни месяца закончились' when 0 days left and plan not fulfilled", () => {
      const res = calculateMonthForecast(180, 100, 21, 21);
      expect(res.daysLeft).toBe(0);
      expect(res.verdict).toBe("Рабочие дни месяца закончились: подписано 100 из 180, это 56% плана.");
    });

    it("outputs 'План месяца уже не закрыть' only in last 5 days when needed pace exceeds 2x current pace", () => {
      // 2 days left, 40 contracts left
      const res2 = calculateMonthForecast(60, 20, 19, 21);
      expect(res2.pacePerDay).toBeCloseTo(1.05, 2);
      expect(res2.need).toBe(20);
      expect(res2.need).toBeGreaterThan(2 * res2.pacePerDay);
      expect(res2.verdict).toBe("План месяца уже не закрыть: осталось 40 договоров за 2 рабочих дня.");

      // 1 day left, 5 contracts left
      const res1 = calculateMonthForecast(25, 20, 20, 21);
      expect(res1.need).toBe(5);
      expect(res1.need).toBeGreaterThan(2 * res1.pacePerDay);
      expect(res1.verdict).toBe("План месяца уже не закрыть: осталось 5 договоров за 1 рабочий день.");

      // 5 days left, 40 contracts left
      const res5 = calculateMonthForecast(50, 10, 15, 20);
      expect(res5.need).toBe(8);
      expect(res5.need).toBeGreaterThan(2 * res5.pacePerDay);
      expect(res5.verdict).toBe("План месяца уже не закрыть: осталось 40 договоров за 5 рабочих дней.");
    });

    it("renders '—' for pace when hasForecast is false", () => {
      const fixturePayload = JSON.parse(
        fs.readFileSync("tests/fixtures/sales-pult/midday.json", "utf8")
      );
      const earlyPayload = {
        ...fixturePayload,
        asOfDate: "2026-11-02",
        generatedAt: "2026-11-02 06:00 (UTC+5)",
        dynamics: []
      };
      const html = renderPultHtml(earlyPayload);
      expect(html).toContain('m.hasForecast ? `${fmt1(m.pacePerDay)}<small> в день</small>` : "—"');
      expect(html).toContain('"hasForecast":false');
    });
  });

  describe("morning state (before 10:00 and zero day metrics)", () => {
    const earlyCtx = calculatePace("2026-10-29", "2026-10-29 06:00 (UTC+5)", DEFAULT_HOLIDAYS);

    it("returns idle status with 'День начнётся в 09:00' when fact is 0 in morning", () => {
      const res = judgeMetricStatus(0, 15, "day", "calls", earlyCtx);
      expect(res.cls).toBe("idle");
      expect(res.text).toBe("День начнётся в 09:00");
      expect(res.expected).toBe(0);
    });

    it("does not trigger zeroBitrixCallsToday red signal before 11:00", () => {
      const payload: SalesPultPayload = {
        asOfDate: "2026-10-29",
        generatedAt: "2026-10-29 06:00 (UTC+5)",
        portal: "https://ft3.bitrix24.kz",
        pultUrl: "https://f3-pult.pages.dev",
        targets: {
          daily: { calls: 15, proposals: 3, contracts: 1 },
          weekly: { calls: 75, proposals: 15, contracts: 5 },
          monthly: { calls: 300, proposals: 60, contracts: 20 }
        },
        callsAvailable: true,
        groups: [
          {
            id: "sales",
            name: "Отдел продаж",
            managers: [
              {
                id: "1",
                name: "Бекзат",
                active: true,
                rollups: {
                  managerId: "1",
                  asOfDate: "2026-10-29",
                  day: {
                    calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                    proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                    contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
                  },
                  week: {
                    calls: { successful: 10, totalAttempts: 15, durationSeconds: 500, durationMinutes: 8, status: "yellow" },
                    proposals: { uniqueDealsCount: 1, dealIds: [], status: "yellow" },
                    contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
                  },
                  month: {
                    calls: { successful: 50, totalAttempts: 70, durationSeconds: 2500, durationMinutes: 41, status: "yellow" },
                    proposals: { uniqueDealsCount: 5, dealIds: [], status: "yellow" },
                    contracts: { uniqueDealsCount: 1, totalAmount: 1000000, dealIds: [], status: "red" }
                  },
                  signals: { zeroBitrixCallsToday: true, zeroKpThreeDays: false }
                },
                topTasks: []
              }
            ]
          }
        ],
        dynamics: []
      };

      const signals = buildPultSignals(payload, earlyCtx);
      const zeroCallsSignal = signals.find((s) => s.text.includes("ни одного звонка через Битрикс"));
      expect(zeroCallsSignal).toBeUndefined();
    });

    it("triggers zeroBitrixCallsToday signal after 11:00", () => {
      const afternoonCtx = calculatePace("2026-10-29", "2026-10-29 11:30 (UTC+5)", DEFAULT_HOLIDAYS);
      const payload: SalesPultPayload = {
        asOfDate: "2026-10-29",
        generatedAt: "2026-10-29 11:30 (UTC+5)",
        portal: "https://ft3.bitrix24.kz",
        pultUrl: "https://f3-pult.pages.dev",
        targets: {
          daily: { calls: 15, proposals: 3, contracts: 1 },
          weekly: { calls: 75, proposals: 15, contracts: 5 },
          monthly: { calls: 300, proposals: 60, contracts: 20 }
        },
        callsAvailable: true,
        groups: [
          {
            id: "sales",
            name: "Отдел продаж",
            managers: [
              {
                id: "1",
                name: "Бекзат",
                active: true,
                rollups: {
                  managerId: "1",
                  asOfDate: "2026-10-29",
                  day: {
                    calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                    proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                    contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
                  },
                  week: {
                    calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                    proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                    contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
                  },
                  month: {
                    calls: { successful: 0, totalAttempts: 0, durationSeconds: 0, durationMinutes: 0, status: "red" },
                    proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" },
                    contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" }
                  },
                  signals: { zeroBitrixCallsToday: true, zeroKpThreeDays: false }
                },
                topTasks: []
              }
            ]
          }
        ],
        dynamics: []
      };

      const signals = buildPultSignals(payload, afternoonCtx);
      const zeroCallsSignal = signals.find((s) => s.text.includes("ни одного звонка через Битрикс"));
      expect(zeroCallsSignal).toBeDefined();
      expect(zeroCallsSignal?.text).toContain("Бекзат");
    });
  });

  describe("disabling pace for proposals and contracts for the day", () => {
    const afternoonCtx = calculatePace("2026-10-29", "2026-10-29 15:00 (UTC+5)", DEFAULT_HOLIDAYS);

    it("evaluates day proposals without pace and with idle status", () => {
      // 0 out of 3: "Сегодня пока ни одного", expected: 0
      const res0 = judgeMetricStatus(0, 3, "day", "proposals", afternoonCtx);
      expect(res0.cls).toBe("idle");
      expect(res0.text).toBe("Сегодня пока ни одного");
      expect(res0.expected).toBe(0);

      // 1 out of 3: "До нормы дня ещё 2", expected: 0
      const res1 = judgeMetricStatus(1, 3, "day", "proposals", afternoonCtx);
      expect(res1.cls).toBe("idle");
      expect(res1.text).toBe("До нормы дня ещё 2");
      expect(res1.expected).toBe(0);

      // 3 out of 3: "План выполнен", expected: 0
      const res3 = judgeMetricStatus(3, 3, "day", "proposals", afternoonCtx);
      expect(res3.cls).toBe("good");
      expect(res3.text).toBe("План выполнен");
    });

    it("evaluates day contracts without pace and with idle status", () => {
      // 0 out of 1: "Сегодня пока ни одного", expected: 0
      const res0 = judgeMetricStatus(0, 1, "day", "contracts", afternoonCtx);
      expect(res0.cls).toBe("idle");
      expect(res0.text).toBe("Сегодня пока ни одного");
      expect(res0.expected).toBe(0);

      // 1 out of 1: "План выполнен", expected: 0
      const res1 = judgeMetricStatus(1, 1, "day", "contracts", afternoonCtx);
      expect(res1.cls).toBe("good");
      expect(res1.text).toBe("План выполнен");
    });

    it("still evaluates calls with pace during the day", () => {
      // Calls target is 15. At 15:00, dayFrac = 6/9 = 2/3. Expected = 15 * (2/3) = 10.
      // Fact = 10 -> "Идём в темпе"
      const onTrack = judgeMetricStatus(10, 15, "day", "calls", afternoonCtx);
      expect(onTrack.cls).toBe("good");
      expect(onTrack.text).toBe("Идём в темпе");
      expect(onTrack.expected).toBe(10);

      // Fact = 8 (8/10 = 0.8) -> "Чуть отстаём, на 2"
      const warn = judgeMetricStatus(8, 15, "day", "calls", afternoonCtx);
      expect(warn.cls).toBe("warn");
      expect(warn.text).toBe("Чуть отстаём, на 2");

      // Fact = 5 (5/10 = 0.5 < 0.8) -> "Отстаём от темпа на 5"
      const bad = judgeMetricStatus(5, 15, "day", "calls", afternoonCtx);
      expect(bad.cls).toBe("bad");
      expect(bad.text).toBe("Отстаём от темпа на 5");
    });
  });

  describe("rules for call conclusions (buildCallNotes)", () => {
    function makePayload(managers: any[]): SalesPultPayload {
      return {
        asOfDate: "2026-10-29",
        generatedAt: "2026-10-29 16:00 (UTC+5)",
        portal: "https://ft3.bitrix24.kz",
        pultUrl: "https://f3-pult.pages.dev",
        targets: {
          daily: { calls: 15, proposals: 3, contracts: 1 },
          weekly: { calls: 75, proposals: 15, contracts: 5 },
          monthly: { calls: 300, proposals: 60, contracts: 20 }
        },
        callsAvailable: true,
        groups: [
          {
            id: "sales",
            name: "Отдел продаж",
            managers: managers.map((m, idx) => ({
              id: String(idx + 1),
              name: m.name,
              active: true,
              rollups: {
                managerId: String(idx + 1),
                asOfDate: "2026-10-29",
                day: { calls: m.day, proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" as const }, contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" as const } },
                week: { calls: m.day, proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" as const }, contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" as const } },
                month: { calls: m.day, proposals: { uniqueDealsCount: 0, dealIds: [], status: "red" as const }, contracts: { uniqueDealsCount: 0, totalAmount: 0, dealIds: [], status: "red" as const } },
                signals: { zeroBitrixCallsToday: m.day.totalAttempts === 0, zeroKpThreeDays: false }
              },
              topTasks: []
            }))
          }
        ],
        dynamics: []
      };
    }

    it("generates separate notes for top calls, low conversion, and short conversation", () => {
      const payload = makePayload([
        { name: "Бахтияр", day: { successful: 15, totalAttempts: 20, durationMinutes: 30 } },
        { name: "Жанат", day: { successful: 4, totalAttempts: 12, durationMinutes: 12 } }, // conv: 33% < 50%, duration avg 3m
        { name: "Турар", day: { successful: 10, totalAttempts: 12, durationMinutes: 10 } }  // avg 1.0m < 1.5m
      ]);

      const notes = buildCallNotes(payload, "day");
      expect(notes.some((n) => n.includes("Больше всех дозвонов: <b>Бахтияр</b>, 15 из 20 наборов."))).toBe(true);
      expect(notes.some((n) => n.includes("<b>Жанат</b>: дозвон только в 33% наборов"))).toBe(true);
      expect(notes.some((n) => n.includes("<b>Турар</b>: средний разговор 1,0 мин, самый короткий в отделе"))).toBe(true);
    });

    it("combines low conversion and short conversation when it is the same manager", () => {
      const payload = makePayload([
        { name: "Бахтияр", day: { successful: 15, totalAttempts: 20, durationMinutes: 30 } },
        { name: "Кайыржан", day: { successful: 6, totalAttempts: 18, durationMinutes: 6 } } // conv: 33% (<50%), avg: 1.0m (<1.5m)
      ]);

      const notes = buildCallNotes(payload, "day");
      expect(notes.some((n) => n.includes("<b>Кайыржан</b>: дозвон только в 33% наборов, а средний разговор 1,0 мин, самый короткий в отделе"))).toBe(true);
    });

    it("shows zero Bitrix calls with nominative name without declension", () => {
      const payload = makePayload([
        { name: "Бахтияр", day: { successful: 15, totalAttempts: 20, durationMinutes: 30 } },
        { name: "Бекзат", day: { successful: 0, totalAttempts: 0, durationMinutes: 0 } }
      ]);

      const notes = buildCallNotes(payload, "day");
      expect(notes.some((n) => n.includes("<b>Бекзат</b>: ни одного звонка через Битрикс сегодня"))).toBe(true);
    });
  });

  describe("HTML entity decoding and text formatting", () => {
    it("decodes common HTML entities correctly before escaping", () => {
      expect(decodeHtmlEntities('работает с &quot;Аданком&quot;')).toBe('работает с "Аданком"');
      expect(decodeHtmlEntities('Цена &lt; 500 &amp; Срок &gt; 10')).toBe('Цена < 500 & Срок > 10');
      expect(decodeHtmlEntities('&#39;Срочно&#39;')).toBe("'Срочно'");
      expect(decodeHtmlEntities('&apos;Важно&apos;')).toBe("'Важно'");
      expect(decodeHtmlEntities('&#34;Тест&#34;')).toBe('"Тест"');
      expect(decodeHtmlEntities('&#x22;Тест&#x22;')).toBe('"Тест"');
    });

    it("cleans task titles and extracts plan number", () => {
      expect(cleanTaskTitle({ title: "[GZ 88001] Поставка оборудования" })).toEqual({
        title: "Поставка оборудования",
        plan: "88001"
      });
      expect(cleanTaskTitle({ title: "88002001 Поставка компьютеров" })).toEqual({
        title: "Поставка компьютеров",
        plan: "88002001"
      });
      expect(cleanTaskTitle({ title: "Обычная сделка" })).toEqual({
        title: "Обычная сделка",
        plan: ""
      });
    });

    it("formats task statuses correctly", () => {
      expect(getTaskStatus({ kind: "new", ageDays: 2 })).toEqual({
        cls: "warn",
        text: "Новая, без звонка 2 дня"
      });
      expect(getTaskStatus({ kind: "new", ageDays: 0 })).toEqual({
        cls: "warn",
        text: "Новая, без звонка с сегодня"
      });
      expect(getTaskStatus({ isOverdue: true, overdueDays: 3 })).toEqual({
        cls: "bad",
        text: "Просрочено на 3 дня"
      });
      expect(getTaskStatus({})).toEqual({
        cls: "",
        text: "Срок сегодня"
      });
    });

    it("formats plural without '(а)' across all number ranges", () => {
      expect(plural(1, ["договор", "договора", "договоров"])).toBe("1 договор");
      expect(plural(2, ["договор", "договора", "договоров"])).toBe("2 договора");
      expect(plural(4, ["договор", "договора", "договоров"])).toBe("4 договора");
      expect(plural(5, ["договор", "договора", "договоров"])).toBe("5 договоров");
      expect(plural(11, ["договор", "договора", "договоров"])).toBe("11 договоров");
      expect(plural(14, ["договор", "договора", "договоров"])).toBe("14 договоров");
      expect(plural(21, ["договор", "договора", "договоров"])).toBe("21 договор");
      expect(plural(22, ["договор", "договора", "договоров"])).toBe("22 договора");
      expect(plural(25, ["договор", "договора", "договоров"])).toBe("25 договоров");
    });

    it("formats money correctly and never returns '0 ₸'", () => {
      expect(formatMoney(0)).toBe("");
      expect(formatMoney(1500)).toBe("1 500 ₸");
      expect(formatMoney(2400000)).toBe("2,4 млн ₸");
      expect(formatMoney(5000000)).toBe("5 млн ₸");
      expect(formatMoney(1200000000)).toBe("1,2 млрд ₸");
    });

    it("decodes unicode codepoint &#128512; and preserves invalid number &#99999999; without throwing", () => {
      expect(decodeHtmlEntities("&#128512;")).toBe("😀");
      expect(decodeHtmlEntities("&#99999999;")).toBe("&#99999999;");
    });
  });

  describe("midday.json view model coverage", () => {
    it("generates expected statuses and signals for midday.json", () => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const middayRaw = fs.readFileSync(
        path.join(__dirname, "../fixtures/sales-pult/midday.json"),
        "utf8"
      );
      const middayPayload = JSON.parse(middayRaw) as SalesPultPayload;
      const view = buildPultView(middayPayload);

      // Verify signals
      expect(view.signals.length).toBeGreaterThan(0);
      expect(
        view.signals.some(
          (s) => s.text.includes("Михаил") && s.text.includes("сегодня ни одного звонка через Битрикс")
        )
      ).toBe(true);
      expect(
        view.signals.some(
          (s) => s.text.includes("Алексей") && s.text.includes("1 новая сделка без звонка")
        )
      ).toBe(true);
      expect(
        view.signals.some(
          (s) =>
            s.text.includes("Иван") &&
            s.text.includes("1 новая сделка без звонка") &&
            s.text.includes("самой старой 3 дня")
        )
      ).toBe(true);
      expect(
        view.signals.some(
          (s) =>
            s.text.includes("Мало дозвонов к 15:10") &&
            s.text.includes("Иван") &&
            s.text.includes("при норме 15")
        )
      ).toBe(true);
      expect(
        view.signals.some((s) => s.text.includes("подписан договор"))
      ).toBe(true);
      expect(
        view.signals.some((s) => s.text.includes("Пора закрыть 1 сделку"))
      ).toBe(true);

      // Verify manager statuses for day
      const dayManagers = view.periods.day.sales.managers;
      const byName = new Map(dayManagers.map((m) => [m.name, m]));

      // «План выполнен»
      expect(byName.get("Алексей Смирнов")?.calls.label).toBe("План выполнен");
      expect(byName.get("Константин Фёдоров")?.calls.label).toBe("План выполнен");

      // «Идём в темпе»
      expect(byName.get("Дмитрий Ковалёв")?.calls.label).toBe("Идём в темпе");

      // «Чуть отстаём, на 1»
      expect(byName.get("Сергей Морозов")?.calls.label).toBe("Чуть отстаём, на 1");

      // «Отстаём от темпа на 6»
      expect(byName.get("Иван Васильев")?.calls.label).toBe("Отстаём от темпа на 6");

      // один без звонков через Битрикс
      expect(byName.get("Михаил Попов")?.calls.noCallsFlag).toBe(true);
    });
  });
});
