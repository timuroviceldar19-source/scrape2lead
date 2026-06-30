import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { extractCardsFromPayload, looksLikeFirm, mapContacts, mapDetail, toLead } from "../src/adapters/2gis/mapper.js";

describe("2GIS mapper", () => {
  it("maps captured JSON to normalized leads", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-response.json", "utf8")) as unknown;
    const cards = extractCardsFromPayload(payload, "autoservice", "moscow");
    expect(cards).toHaveLength(2);

    const detail = mapDetail(cards[0], cards[0].payload as Record<string, unknown>);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.external_id).toBe("70000001000000123");
    expect(lead.company_name).toBe("Demo Autoservice");
    expect(lead.phones).toEqual(["+77771234567"]);
    expect(lead.email).toBe("info@example.com");
    expect(lead.website).toBe("https://example.com");
    expect(lead.incomplete).toBe(false);
  });

  it("maps a real firm-results payload into valid leads", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-firm-results.json", "utf8")) as unknown;
    const cards = extractCardsFromPayload(payload, "Автосервисы", "Новосибирск");
    expect(cards).toHaveLength(2);

    const lead = toLead(...detailAndContacts(cards[0]));
    expect(lead.source).toBe("2gis");
    expect(lead.external_id).toBe("70000001045123456");
    expect(lead.company_name).toBe("АвтоТехЦентр на Кирова");
    expect(lead.category).toBe("Автосервис, автотехцентр");
    expect(lead.city).toBe("Новосибирск");
    expect(lead.address).toBe("Кирова, 27");
    expect(lead.phones).toEqual(["+73832001020"]);
    expect(lead.website).toBe("https://avtotech-nsk.ru");
    expect(lead.email).toBe("info@avtotech-nsk.ru");
    expect(lead.incomplete).toBe(false);
  });

  it("ignores analytics / webvisor payloads", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-analytics.json", "utf8")) as unknown;
    expect(extractCardsFromPayload(payload, "Автосервисы", "Новосибирск")).toEqual([]);
  });

  it("ignores map-asset / UI / promo payloads", () => {
    const payload = JSON.parse(fs.readFileSync("tests/fixtures/2gis-map-assets.json", "utf8")) as unknown;
    expect(extractCardsFromPayload(payload, "Автосервисы", "Новосибирск")).toEqual([]);
  });

  it("rejects map style layers, global map records and 2GIS business promos", () => {
    const junk = [
      { id: "background-static", type: "style", name: "[light] Фон со статичной текстурой" },
      { id: "global-map", type: "map", name: "Глобальная карта", address_name: "—" },
      { id: "70000001099999999", type: "adsBlock", name: "Данные и технологии 2ГИС для бизнеса", address_name: "реклама" }
    ];
    for (const item of junk) {
      expect(looksLikeFirm(item)).toBe(false);
    }
  });

  it("accepts a real firm record", () => {
    expect(
      looksLikeFirm({
        id: "70000001045123456",
        type: "branch",
        name: "АвтоТехЦентр на Кирова",
        address_name: "Кирова, 27",
        rubrics: [{ name: "Автосервис" }]
      })
    ).toBe(true);
  });
});

function detailAndContacts(card: ReturnType<typeof extractCardsFromPayload>[number]) {
  const detail = mapDetail(card, card.payload as Record<string, unknown>);
  const contacts = mapContacts(detail, detail.payload);
  return [detail, contacts] as const;
}
