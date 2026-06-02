import { describe, expect, it } from "vitest";
import { buildDomFirmPayload, buildSearchUrl, citySegment, hasUsableTelLink, type DomFirmLink, type DomFirmSnapshot } from "../src/adapters/2gis/TwoGisAdapter.js";
import { mapContacts, mapDetail, toLead } from "../src/adapters/2gis/mapper.js";
import type { RawCompanyCard } from "../src/types.js";

function makeLink(href: string, text: string, ariaLabel: string = ""): DomFirmLink {
  return { href, text, ariaLabel };
}

function makeSnapshot(partial: Partial<DomFirmSnapshot>): DomFirmSnapshot {
  return {
    title: "",
    url: "https://2gis.ru/novosibirsk/firm/70000001006434211",
    scope: "panel",
    h1: [],
    buttons: [],
    telLinks: [],
    mailtoLinks: [],
    addressLinks: [],
    httpLinks: [],
    allAnchors: [],
    selectorCounts: {},
    ...partial
  };
}

describe("2GIS DOM detail extraction", () => {
  it("uses the 2GIS city slug for Novosibirsk search URLs", () => {
    expect(citySegment("\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a")).toBe("novosibirsk");
    expect(buildSearchUrl("\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a", "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b"))
      .toBe("https://2gis.ru/novosibirsk/search/%D0%90%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81%D1%8B");
  });

  it("builds a sanitized firm payload from a scoped detail-card DOM", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001006434211",
      name: "\u0410\u0432\u0442\u043e\u0432\u0435\u0440\u0441\u0438\u044f",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001006434211?stat=secret",
      payload: { href: "https://2gis.ru/novosibirsk/firm/70000001006434211?stat=secret" }
    };
    const snapshot = makeSnapshot({
      title: "\u0410\u0432\u0442\u043e\u0432\u0435\u0440\u0441\u0438\u044f, \u0441\u043f\u0435\u0446\u0438\u0430\u043b\u0438\u0437\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0441\u0435\u0440\u0432\u0438\u0441\u043d\u044b\u0439 \u0446\u0435\u043d\u0442\u0440, \u0443\u043b\u0438\u0446\u0430 \u0416\u0443\u043a\u043e\u0432\u0441\u043a\u043e\u0433\u043e, 96/2, \u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a \u2014 2\u0413\u0418\u0421",
      url: "https://2gis.ru/novosibirsk/firm/70000001006434211?stat=secret",
      h1: ["\u0410\u0432\u0442\u043e\u0432\u0435\u0440\u0441\u0438\u044f"],
      buttons: ["\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0442\u0435\u043b\u0435\u0444\u043e\u043d"],
      telLinks: [makeLink("tel:+73833885567", "+7 (383) 388-55-67")],
      mailtoLinks: [makeLink("mailto:info@toyota-lexus.su", "info@toyota-lexus.su")],
      addressLinks: [makeLink("https://2gis.ru/novosibirsk/geo/70000001006434211", "\u0443\u043b\u0438\u0446\u0430 \u0416\u0443\u043a\u043e\u0432\u0441\u043a\u043e\u0433\u043e, 96/2")],
      httpLinks: [makeLink("https://link.2gis.ru/4.2/token-with-session-data", "www.toyota-lexus.su")],
      allAnchors: [
        makeLink("tel:+73833885567", "+7 (383) 388-55-67"),
        makeLink("mailto:info@toyota-lexus.su", "info@toyota-lexus.su"),
        makeLink("https://link.2gis.ru/4.2/token-with-session-data", "www.toyota-lexus.su")
      ],
      selectorCounts: {
        h1: 1,
        "a[href^='tel:']": 1,
        "a[href^='mailto:']": 1,
        "a[href*='/geo/']": 1,
        "a[href^='http']": 1
      }
    });

    const { payload, debug } = buildDomFirmPayload(
      snapshot,
      card,
      "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      { present: true, clicked: 1, labels: ["\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0442\u0435\u043b\u0435\u0444\u043e\u043d"] }
    );
    const detail = mapDetail(card, payload);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.company_name).toBe("\u0410\u0432\u0442\u043e\u0432\u0435\u0440\u0441\u0438\u044f");
    expect(lead.address).toBe("\u0443\u043b\u0438\u0446\u0430 \u0416\u0443\u043a\u043e\u0432\u0441\u043a\u043e\u0433\u043e, 96/2");
    expect(lead.phones).toEqual(["+73833885567"]);
    expect(lead.email).toBe("info@toyota-lexus.su");
    expect(lead.website).toBe("https://www.toyota-lexus.su");
    expect(lead.incomplete).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("token-with-session-data");
    expect(JSON.stringify(debug)).not.toContain("388-55-67");
    expect((debug as { scope: string }).scope).toBe("panel");
  });

  it("does not treat 2GIS firm URLs, footer links or otello.ru as firm websites", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "141265770954081",
      name: "\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/141265770954081",
      payload: {}
    };
    const snapshot = makeSnapshot({
      title: "\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c, \u0430\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441, \u0443\u043b\u0438\u0446\u0430 \u0424\u0440\u0443\u043d\u0437\u0435, 104\u0411, \u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a \u2014 2\u0413\u0418\u0421",
      url: "https://2gis.ru/novosibirsk/firm/141265770954081",
      h1: ["\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c"],
      telLinks: [makeLink("tel:+73832392210", "+7 (383) 239-22-10")],
      mailtoLinks: [makeLink("mailto:autopremium54@gmail.com", "autopremium54@gmail.com")],
      httpLinks: [
        makeLink("https://2gis.ru/novosibirsk/firm/141265770954081", "\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c"),
        makeLink("https://otello.ru/", "\u041e\u0442\u0435\u043b\u0438 \u0438 \u0433\u043e\u0441\u0442\u0438\u043d\u0438\u0446\u044b")
      ]
    });

    const { payload } = buildDomFirmPayload(snapshot, card, "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b", "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a");
    const detail = mapDetail(card, payload);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.website).toBeNull();
    expect(lead.phones).toEqual(["+73832392210"]);
    expect(lead.email).toBe("autopremium54@gmail.com");
  });

  it("uses the geo-anchor text for address even when the page title contains the firm name", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "141265770954081",
      name: "\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/141265770954081",
      payload: {}
    };
    // Title pattern on 2GIS is "<name>, <category>, <street>, <city> — 2ГИС".
    // The title has the firm name + address; we want the address text from
    // the geo anchor (more reliable than parsing the title, and never
    // bleeds in the firm name).
    const snapshot = makeSnapshot({
      title: "\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c, \u0430\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441, \u0443\u043b\u0438\u0446\u0430 \u0424\u0440\u0443\u043d\u0437\u0435, 104\u0411, \u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a \u2014 2\u0413\u0418\u0421",
      h1: ["\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c"],
      addressLinks: [makeLink("https://2gis.ru/novosibirsk/geo/141265770954081", "\u0443\u043b\u0438\u0446\u0430 \u0424\u0440\u0443\u043d\u0437\u0435, 104\u0411")]
    });

    const { payload } = buildDomFirmPayload(snapshot, card, "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b", "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a");
    const detail = mapDetail(card, payload);

    expect(detail.address).toBe("\u0443\u043b\u0438\u0446\u0430 \u0424\u0440\u0443\u043d\u0437\u0435, 104\u0411");
    expect(detail.address).not.toContain("\u0410\u0432\u0442\u043e \u041f\u0440\u0435\u043c\u0438\u0443\u043c");
  });

  it("uses a tel: href with digits and skips the masked-text phone reveal", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001000000123",
      name: "Test Firm",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001000000123",
      payload: {}
    };
    // Common 2GIS masked-phone shape: a button labelled "Показать телефон"
    // and a placeholder tel: href that has no digits. The reveal gate must
    // treat the placeholder as "not usable" so the click goes through.
    const masked = makeSnapshot({
      title: "Test Firm \u2014 2\u0413\u0418\u0421",
      h1: ["Test Firm"],
      buttons: ["\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0442\u0435\u043b\u0435\u0444\u043e\u043d"],
      telLinks: [makeLink("tel:", "\u0421\u043a\u0440\u044b\u0442")],
      mailtoLinks: []
    });
    const revealed = makeSnapshot({
      ...masked,
      telLinks: [makeLink("tel:+73832001020", "+7 (383) 200-10-20")]
    });
    const revealedPayload = buildDomFirmPayload(
      revealed,
      card,
      "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      { present: true, clicked: 1, labels: ["\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0442\u0435\u043b\u0435\u0444\u043e\u043d"] }
    ).payload;

    // Phone-reveal gate: masked tel: → no usable link → reveal would be
    // triggered; revealed tel: → has digits → no extra click.
    expect(hasUsableTelLink(masked)).toBe(false);
    expect(hasUsableTelLink(revealed)).toBe(true);

    const detail = mapDetail(card, revealedPayload);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);
    expect(lead.phones).toEqual(["+73832001020"]);
    expect(lead.incomplete).toBe(false);
  });

  it("uses the visible domain text for website when href is a link.2gis.ru redirect", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001000000999",
      name: "Some Firm",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001000000999",
      payload: {}
    };
    const snapshot = makeSnapshot({
      title: "Some Firm \u2014 2\u0413\u0418\u0421",
      h1: ["Some Firm"],
      httpLinks: [makeLink("https://link.2gis.ru/4.2/tracking-token", "avtoservice-nsk.ru")]
    });
    const { payload, debug } = buildDomFirmPayload(
      snapshot,
      card,
      "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a"
    );
    const detail = mapDetail(card, payload);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.website).toBe("https://avtoservice-nsk.ru");
    expect(JSON.stringify(payload)).not.toContain("tracking-token");
    expect(JSON.stringify(debug)).not.toContain("tracking-token");
  });

  it("extracts mailto: addresses from the detail panel", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001000000555",
      name: "Mail Test",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001000000555",
      payload: {}
    };
    const snapshot = makeSnapshot({
      h1: ["Mail Test"],
      mailtoLinks: [makeLink("mailto:order@shop.ru?subject=test", "order@shop.ru")]
    });
    const { payload } = buildDomFirmPayload(snapshot, card, "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b", "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a");
    const detail = mapDetail(card, payload);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.email).toBe("order@shop.ru");
  });

  it("extracts messenger providers from anchor text and aria-label without storing redirect URLs", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001000000444",
      name: "Messenger Test",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001000000444",
      payload: {}
    };
    const snapshot = makeSnapshot({
      h1: ["Messenger Test"],
      allAnchors: [
        makeLink("https://link.2gis.ru/4.2/whatsapp-token", "WhatsApp", "WhatsApp"),
        makeLink("https://link.2gis.ru/4.2/telegram-token", "Telegram", "Telegram"),
        makeLink("https://link.2gis.ru/4.2/max-token", "Max", "Max"),
        makeLink("https://link.2gis.ru/4.2/viber-token", "Viber", "Viber")
      ]
    });
    const { payload, debug } = buildDomFirmPayload(
      snapshot,
      card,
      "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a"
    );
    const detail = mapDetail(card, payload);
    const contacts = mapContacts(detail, detail.payload);
    const lead = toLead(detail, contacts);

    expect(lead.messenger_links).toEqual(["WhatsApp", "Telegram", "Max", "Viber"]);
    expect(JSON.stringify(payload)).not.toContain("whatsapp-token");
    expect(JSON.stringify(payload)).not.toContain("telegram-token");
    expect(JSON.stringify(payload)).not.toContain("max-token");
    expect(JSON.stringify(payload)).not.toContain("viber-token");
    expect(JSON.stringify(debug)).not.toContain("whatsapp-token");
    expect(JSON.stringify(debug)).not.toContain("telegram-token");
    expect(JSON.stringify(debug)).not.toContain("max-token");
    expect(JSON.stringify(debug)).not.toContain("viber-token");
  });

  it("does not let list/sidebar firm links override the selected detail-panel fields", () => {
    // The audit calls this out specifically: when the page has BOTH the
    // search-results list and the opened detail panel, the extraction must
    // only use anchors that live inside the panel. A scoped snapshot
    // contains only the panel anchors; a global "document" snapshot would
    // have mixed in unrelated firm list items.
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001006434211",
      name: "Target Firm",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001006434211",
      payload: {}
    };
    const panelSnapshot = makeSnapshot({
      scope: "panel",
      h1: ["Target Firm"],
      addressLinks: [makeLink("https://2gis.ru/novosibirsk/geo/70000001006434211", "\u0443\u043b\u0438\u0446\u0430 \u041b\u0435\u043d\u0438\u043d\u0430, 1")],
      telLinks: [makeLink("tel:+73832001010", "+7 (383) 200-10-10")]
    });
    // Document-wide snapshot that *also* carries anchors from the
    // sidebar list of OTHER firms. The mapper must not let these leak
    // into the selected card's record.
    const documentSnapshot = makeSnapshot({
      scope: "document",
      h1: ["Target Firm", "Other Firm A", "Other Firm B", "Other Firm C"],
      addressLinks: [
        makeLink("https://2gis.ru/novosibirsk/geo/70000001006434211", "\u0443\u043b\u0438\u0446\u0430 \u041b\u0435\u043d\u0438\u043d\u0430, 1"),
        makeLink("https://2gis.ru/novosibirsk/geo/90000001000000001", "\u0443\u043b\u0438\u0446\u0430 \u0421\u0438\u0431\u0438\u0440\u0441\u043a\u0430\u044f, 99"),
        makeLink("https://2gis.ru/novosibirsk/geo/90000001000000002", "\u0443\u043b\u0438\u0446\u0430 \u0411\u043e\u043b\u044c\u0448\u0435\u0432\u0438\u0441\u0442\u0441\u043a\u0430\u044f, 50")
      ],
      telLinks: [
        makeLink("tel:+73832001010", "+7 (383) 200-10-10"),
        makeLink("tel:+73835555555", "+7 (383) 555-55-55"),
        makeLink("tel:+73837777777", "+7 (383) 777-77-77")
      ]
    });

    const panelPayload = buildDomFirmPayload(
      panelSnapshot,
      card,
      "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a"
    ).payload;
    const documentPayload = buildDomFirmPayload(
      documentSnapshot,
      card,
      "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a"
    ).payload;

    const panelDetail = mapDetail(card, panelPayload);
    const panelContacts = mapContacts(panelDetail, panelDetail.payload);
    const panelLead = toLead(panelDetail, panelContacts);

    const documentDetail = mapDetail(card, documentPayload);
    const documentContacts = mapContacts(documentDetail, documentDetail.payload);
    const documentLead = toLead(documentDetail, documentContacts);

    // Scoped panel extraction: only the selected firm's address/phone.
    expect(panelLead.address).toBe("\u0443\u043b\u0438\u0446\u0430 \u041b\u0435\u043d\u0438\u043d\u0430, 1");
    expect(panelLead.phones).toEqual(["+73832001010"]);

    // Unscoped document extraction: leaks sidebar phones/addresses. This
    // is the *observed bad* state. The test pins it so a future regression
    // to "use document-wide anchors" trips an explicit, named failure.
    expect(documentLead.phones).toEqual(["+73832001010", "+73835555555", "+73837777777"]);
    expect((documentPayload.dom_debug as { scope: string }).scope).toBe("document");
  });

  it("marks the lead as complete when a phone is present", () => {
    const card: RawCompanyCard = {
      source: "2gis",
      externalId: "70000001000000111",
      name: "Completeness Test",
      category: "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b",
      city: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a",
      address: "",
      url: "https://2gis.ru/novosibirsk/firm/70000001000000111",
      payload: {}
    };
    const phoneOnly = makeSnapshot({
      h1: ["Completeness Test"],
      telLinks: [makeLink("tel:+73832001020", "+7 (383) 200-10-20")]
    });
    const noPhone = makeSnapshot({
      h1: ["Completeness Test"]
    });

    const phonePayload = buildDomFirmPayload(phoneOnly, card, "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b", "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a").payload;
    const noPhonePayload = buildDomFirmPayload(noPhone, card, "\u0410\u0432\u0442\u043e\u0441\u0435\u0440\u0432\u0438\u0441\u044b", "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a").payload;

    const phoneDetail = mapDetail(card, phonePayload);
    const phoneContacts = mapContacts(phoneDetail, phoneDetail.payload);
    const phoneLead = toLead(phoneDetail, phoneContacts);
    expect(phoneLead.incomplete).toBe(false);

    const noPhoneDetail = mapDetail(card, noPhonePayload);
    const noPhoneContacts = mapContacts(noPhoneDetail, noPhoneDetail.payload);
    const noPhoneLead = toLead(noPhoneDetail, noPhoneContacts);
    expect(noPhoneLead.incomplete).toBe(true);
  });
});
