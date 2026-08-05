import { describe, expect, it } from "vitest";
import {
  DOSSIER_COMMENT_MARKER,
  hasDossierComment,
  renderDossierComment
} from "../../src/bitrix/customerDossierComment.js";
import type { CustomerDossier } from "../../src/kz/goszakupCustomerDossier.js";

const DOSSIER: CustomerDossier = {
  bin: "031040002509",
  query: "Компьютер",
  lots: [],
  awards: [],
  officers: [
    {
      fullName: "ТУРГАМБЕКОВА НАЗИРА ОМАРКЫЗЫ",
      position: "Специалист отдела государственных закупок",
      email: "tazalyk.almaty@mail.ru",
      announceIds: ["16744298", "13939020"]
    },
    { fullName: "БАЙЖАН ТАЛҒАТ АСЫЛХАНҰЛЫ", position: null, email: null, announceIds: ["16714116"] }
  ],
  summary: {
    lotsTotal: 19,
    lotsAwarded: 3,
    lotsFailed: 7,
    plannedTotal: 30_132_800,
    contractedTotal: 20_909_920,
    averageDiscountPercent: 30.61,
    suppliers: [
      { name: 'ТОО "Steppe System Security"', bin: "190140006079", wins: 1, contractedTotal: 14_284_920 }
    ],
    priceHistory: [
      {
        lotNumber: "81335611-ЗЦП2",
        announceId: "16744298",
        quantity: 40,
        plannedAmount: 22_332_800,
        contractedAmount: 14_284_920,
        plannedUnitPrice: 558_320,
        contractedUnitPrice: 357_123,
        discountPercent: 36.04,
        supplierName: 'ТОО "Steppe System Security"',
        supplierBin: "190140006079"
      }
    ]
  }
};

describe("renderDossierComment", () => {
  const comment = renderDossierComment(DOSSIER, { collectedAt: "2026-08-06" });

  it("carries the marker so a rerun can detect its own comment", () => {
    expect(comment).toContain(DOSSIER_COMMENT_MARKER);
  });

  it("names the procurement officers with their contacts", () => {
    expect(comment).toContain("ТУРГАМБЕКОВА НАЗИРА ОМАРКЫЗЫ");
    expect(comment).toContain("tazalyk.almaty@mail.ru");
  });

  it("states unit prices and the gap between plan and contract", () => {
    expect(comment).toContain("558 320");
    expect(comment).toContain("357 123");
    expect(comment).toContain("36.04%");
  });

  it("lists who wins at this customer", () => {
    expect(comment).toContain('ТОО "Steppe System Security"');
    expect(comment).toContain("190140006079");
  });

  it("says plainly when there is no purchase history to show", () => {
    const empty = renderDossierComment(
      { ...DOSSIER, officers: [], summary: { ...DOSSIER.summary, lotsTotal: 0, priceHistory: [], suppliers: [] } },
      { collectedAt: "2026-08-06" }
    );
    expect(empty).toContain("не найдено");
    expect(empty).toContain(DOSSIER_COMMENT_MARKER);
  });
});

describe("hasDossierComment", () => {
  it("detects a dossier posted by an earlier run", () => {
    expect(hasDossierComment([{ COMMENT: `что-то\n${DOSSIER_COMMENT_MARKER}` }])).toBe(true);
  });

  it("ignores unrelated manager comments", () => {
    expect(hasDossierComment([{ COMMENT: "созвон в четверг" }, {}])).toBe(false);
  });
});
