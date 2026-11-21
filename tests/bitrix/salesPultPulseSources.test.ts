import { describe, expect, it } from "vitest";
import { buildManagerPulse, buildMorningPulse, lossPulseItems } from "../../src/bitrix/salesPult/pulse.js";
import { buildDirectorDigest } from "../../src/bitrix/salesPult/chatReport.js";
import type { RecentCheaperRejectionsSummary } from "../../src/kz/competitors/losses.js";

// Все данные выдуманные: лоты, суммы, компании.
const AS_OF = "2026-11-17";
const NOW = "2026-11-17T04:00:00.000Z";

function summary(items: Array<{ group: "ИП" | "КТ"; ourPrice: number }>): RecentCheaperRejectionsSummary {
  return {
    count: items.length,
    sumOur: items.reduce((s, x) => s + x.ourPrice, 0),
    items: items.map((x, i) => ({
      group: x.group, lotNumber: `L-${i}`, date: "2026-11-16", kind: "Интерактивные панели",
      ourPrice: x.ourPrice, winnerPrice: x.ourPrice + 100_000, url: "https://example.invalid/lot",
      ourCompany: "ТОО «Демо Ф3»", customerName: "Школа Тест"
    }))
  };
}

describe("пульс: свежие отклонения при цене ниже победителя", () => {
  it("даёт красный пункт с суммой и ведёт на вкладку группы с большей суммой", () => {
    const items = lossPulseItems(summary([
      { group: "КТ", ourPrice: 3_000_000 },
      { group: "ИП", ourPrice: 1_000_000 },
      { group: "КТ", ourPrice: 2_000_000 }
    ]));
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.severity).toBe("red");
    expect(item.area).toBe("losses");
    expect(item.amount).toBe(6_000_000);
    expect(item.href).toBe("#competitors-kt");
    expect(item.title).toMatch(/ниже победителя/);
    expect(item.value).toMatch(/3 заявки/);
    // данные «Конкурентов» закрыты: менеджеру и на ТВ не показываются
    expect(item.finance).toBe(true);
  });

  it("без свежих отклонений или без данных пунктов нет", () => {
    expect(lossPulseItems(summary([]))).toEqual([]);
    expect(lossPulseItems(null)).toEqual([]);
    expect(lossPulseItems(undefined)).toEqual([]);
  });

  it("попадает в пульс директора и в дайджест, но не в пульс менеджера", () => {
    const extra = lossPulseItems(summary([{ group: "ИП", ourPrice: 4_000_000 }]));
    const pulse = buildMorningPulse({ asOfDate: AS_OF, nowIso: NOW, extraItems: extra });
    expect(pulse.items.map((i) => i.key)).toContain("losses-cheaper");
    expect(buildDirectorDigest(pulse, "https://example.invalid/")).toMatch(/ниже победителя/);
    const managerPulse = buildManagerPulse(null, AS_OF, NOW);
    expect(managerPulse.items.some((i) => i.area === "losses")).toBe(false);
  });
});
