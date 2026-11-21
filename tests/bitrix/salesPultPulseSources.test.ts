import { describe, expect, it } from "vitest";
import { buildManagerPulse, buildMorningPulse, lossPulseItems } from "../../src/bitrix/salesPult/pulse.js";
import { buildDirectorDigest } from "../../src/bitrix/salesPult/chatReport.js";
import type { RecentCheaperRejectionsSummary } from "../../src/kz/competitors/losses.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { emptyRadarGroup, computeRadarKpis } from "../../src/bitrix/salesPult/radar/aggregate.js";
import type { RadarCard } from "../../src/bitrix/salesPult/radar/types.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";

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

describe("пульс менеджера из его личного радара (пункты 1 и 2 вместе)", () => {
  const lot = (id: string, managerId: string, managerName: string, endAt: string, sum: number): RadarCard => ({
    id, dealUrl: `https://example.invalid/crm/deal/details/${id}/`, sourceType: "lot", lotNumber: `LOT-${id}`,
    title: `GZ LOT-${id}`, itemName: "Панель выдуманная", qty: 2, sum, method: "Запрос ценовых предложений",
    status: "Опубликован (прием заявок)", group: "ИП", kind: "Интерактивные панели", customerName: "Школа Тест",
    customerBin: "000000000001", managerId, managerName, startAt: "2026-10-20 10:00", endAt,
    hoursLeft: null, isToday: true, isWithin48h: true, column: "submitToday"
  });

  it("у менеджера в пульсе только его горящий лот; чужой лот и финансы в HTML не попадают", () => {
    const f = fixture();
    const submitToday = [
      lot("501", "s", "Алия Тестовая", "2026-10-28 15:00", 7_000_000),
      lot("502", "t", "Борис Тестовый", "2026-10-28 16:00", 9_000_000)
    ];
    const ip = { ...emptyRadarGroup("ИП"), submitToday, kpis: computeRadarKpis({ submitToday, discussion: [], secondChance: [], missed: [] }) };
    f.payload.radar = { asOf: f.payload.asOfDate, ip, kt: emptyRadarGroup("КТ") };
    const variant = buildManagerVariant({
      pult: f.payload, reg: { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, register: f.register },
      planDeals: null, managerId: "s", aliases: f.aliases
    })!;
    const pulse = variant.pult.pulse!;
    expect(pulse.items.length).toBeGreaterThan(0);
    expect(pulse.items.every((i) => i.area === "tender" && !i.finance)).toBe(true);
    expect(pulse.missing).toEqual([]);
    const html = renderManagerVariant(variant).index;
    expect(html).toContain("LOT-501");
    expect(html).not.toContain("LOT-502");
    expect(html).not.toContain("Борис Тестовый");
  });
});
