import { describe, expect, it } from "vitest";
import {
  anchorToFirmCandidate,
  evaluateStopCondition,
  FIRM_HREF_RE,
  markerIdToFirmId,
  mergeCandidates,
  selectFirmCardCandidates,
  synthesizeCardsFromMarkersPayload,
  type CollectionState,
  type FirmCardAnchor,
  type FirmCardCandidate
} from "../src/adapters/2gis/discoveryFallback.js";

function anchor(href: string, text: string, ariaLabel = ""): FirmCardAnchor {
  return { href, text, ariaLabel };
}

function candidate(externalId: string, name: string, url: string): FirmCardCandidate {
  return { externalId, name, url };
}

function makeState(partial: Partial<CollectionState>): CollectionState {
  return {
    collected: 0,
    limit: 50,
    scrollAttempts: 0,
    maxScrollAttempts: 60,
    consecutiveStagnantScrolls: 0,
    noNewCardThreshold: 3,
    deadlineMs: Number.POSITIVE_INFINITY,
    nowMs: 0,
    softBlockDetected: false,
    captchaDetected: false,
    ...partial
  };
}

describe("2GIS DOM-fallback firm anchor selection", () => {
  it("extracts the firm id from a /firm/<id> anchor and keeps the visible name", () => {
    const out = anchorToFirmCandidate(
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908?stat=secret", "АРВ-сервис")
    );
    expect(out).toEqual({
      externalId: "70000001036934908",
      name: "АРВ-сервис",
      url: "https://2gis.ru/novosibirsk/firm/70000001036934908"
    });
  });

  it("falls back to aria-label when the anchor has no visible text (icon-only firm link)", () => {
    const out = anchorToFirmCandidate(
      anchor("https://2gis.ru/novosibirsk/firm/141265770449559", "", "REAKTOR на Писарева")
    );
    expect(out).toEqual({
      externalId: "141265770449559",
      name: "REAKTOR на Писарева",
      url: "https://2gis.ru/novosibirsk/firm/141265770449559"
    });
  });

  it("rejects anchors whose href has no /firm/<id> segment", () => {
    expect(anchorToFirmCandidate(anchor("https://2gis.ru/novosibirsk/geo/70000001036934908", "geo"))).toBeNull();
    expect(anchorToFirmCandidate(anchor("https://2gis.ru/novosibirsk/firm/", "no id"))).toBeNull();
    expect(anchorToFirmCandidate(anchor("https://2gis.ru/novosibirsk/firm/12345", "id too short"))).toBeNull();
  });

  it("rejects anchors with empty name (icon-only map pins and UI placeholders)", () => {
    expect(anchorToFirmCandidate(anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", ""))).toBeNull();
    expect(anchorToFirmCandidate(anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "   "))).toBeNull();
  });

  it("rejects anchors marked as promo / sponsored entries", () => {
    expect(
      anchorToFirmCandidate(
        anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "Реклама")
      )
    ).toBeNull();
    expect(
      anchorToFirmCandidate(
        anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "Sponsored")
      )
    ).toBeNull();
  });

  it("FIRM_HREF_RE matches only long numeric firm ids in /firm/ paths", () => {
    expect("https://2gis.ru/novosibirsk/firm/70000001036934908".match(FIRM_HREF_RE)?.[1]).toBe("70000001036934908");
    expect("https://2gis.ru/novosibirsk/firm/141265770449559/tab/reviews".match(FIRM_HREF_RE)?.[1]).toBe(
      "141265770449559"
    );
    expect("https://2gis.ru/novosibirsk/firm/foo".match(FIRM_HREF_RE)).toBeNull();
    expect("https://2gis.ru/novosibirsk/geo/70000001036934908".match(FIRM_HREF_RE)).toBeNull();
  });
});

describe("2GIS DOM-fallback initial collection", () => {
  it("collects every visible firm card on the initial pass", () => {
    const anchors: FirmCardAnchor[] = [
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", "Автоверсия"),
      anchor("https://2gis.ru/novosibirsk/firm/141265769935931", "ТОП МОТОРС")
    ];
    expect(selectFirmCardCandidates(anchors)).toEqual([
      candidate("70000001036934908", "АРВ-сервис", "https://2gis.ru/novosibirsk/firm/70000001036934908"),
      candidate("70000001006434211", "Автоверсия", "https://2gis.ru/novosibirsk/firm/70000001006434211"),
      candidate("141265769935931", "ТОП МОТОРС", "https://2gis.ru/novosibirsk/firm/141265769935931")
    ]);
  });

  it("filters out non-firm anchors mixed in with the firm cards (map pins, geo links, UI buttons)", () => {
    const anchors: FirmCardAnchor[] = [
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис"),
      anchor("https://2gis.ru/novosibirsk/geo/70000001036934908", "Улица Островского, 188"),
      anchor("https://2gis.ru/novosibirsk/firm/abc", "Promo with non-numeric id"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", ""),
      anchor("https://2gis.ru/novosibirsk/firm/70000001019875771", "Реклама"),
      anchor("https://2gis.ru/novosibirsk/firm/141265769935931", "ТОП МОТОРС")
    ];
    expect(selectFirmCardCandidates(anchors)).toEqual([
      candidate("70000001036934908", "АРВ-сервис", "https://2gis.ru/novosibirsk/firm/70000001036934908"),
      candidate("141265769935931", "ТОП МОТОРС", "https://2gis.ru/novosibirsk/firm/141265769935931")
    ]);
  });

  it("dedupes by externalId within a single batch, keeping the first occurrence", () => {
    const anchors: FirmCardAnchor[] = [
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908/tab/reviews", "АРВ-сервис — отзывы"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908?stat=secret", "АРВ-сервис")
    ];
    const out = selectFirmCardCandidates(anchors);
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe("70000001036934908");
    expect(out[0].name).toBe("АРВ-сервис");
    // Query-string secrets are stripped on the way out.
    expect(out[0].url).toBe("https://2gis.ru/novosibirsk/firm/70000001036934908");
  });
});

describe("2GIS DOM-fallback scroll-batch merge / dedupe", () => {
  it("appends new firm cards across batches and counts duplicates", () => {
    // First scroll surfaces three firms; second scroll surfaces two of
    // the previous three (already in view) plus two new firms below the
    // fold. The merged list must be five unique cards and the duplicate
    // count must reflect the two repeats.
    const first = selectFirmCardCandidates([
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", "Автоверсия"),
      anchor("https://2gis.ru/novosibirsk/firm/141265769935931", "ТОП МОТОРС")
    ]);
    const second = selectFirmCardCandidates([
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", "Автоверсия"),
      anchor("https://2gis.ru/novosibirsk/firm/141265769935931", "ТОП МОТОРС"),
      anchor("https://2gis.ru/novosibirsk/firm/141265770449559", "REAKTOR"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001019875771", "Лада-Центр")
    ]);

    const result = mergeCandidates(first, second);
    expect(result.merged.map((c) => c.externalId)).toEqual([
      "70000001036934908",
      "70000001006434211",
      "141265769935931",
      "141265770449559",
      "70000001019875771"
    ]);
    expect(result.added).toBe(2);
    expect(result.duplicates).toBe(2);
  });

  it("never mutates the existing list", () => {
    const existing = selectFirmCardCandidates([
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис")
    ]);
    const before = existing.slice();
    mergeCandidates(existing, selectFirmCardCandidates([
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", "Автоверсия")
    ]));
    expect(existing).toEqual(before);
  });

  it("reports zero new cards when the batch is fully duplicated", () => {
    const existing = selectFirmCardCandidates([
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", "Автоверсия")
    ]);
    const repeat = selectFirmCardCandidates([
      anchor("https://2gis.ru/novosibirsk/firm/70000001036934908", "АРВ-сервис"),
      anchor("https://2gis.ru/novosibirsk/firm/70000001006434211", "Автоверсия")
    ]);
    const result = mergeCandidates(existing, repeat);
    expect(result.added).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.merged).toHaveLength(2);
  });
});

describe("2GIS DOM-fallback stop conditions", () => {
  it("does not stop while there is room and the budget is not exhausted", () => {
    expect(evaluateStopCondition(makeState({ collected: 10, limit: 50 }))).toEqual({ stop: false });
  });

  it("stops as soon as the collected count reaches the requested limit", () => {
    expect(evaluateStopCondition(makeState({ collected: 50, limit: 50 }))).toEqual({
      stop: true,
      reason: "limit_reached"
    });
    // Overshoot is also `limit_reached` — the upstream slice(0, limit)
    // caps the output, so collecting a couple of extras is not a bug
    // (it just trips the same stop reason).
    expect(evaluateStopCondition(makeState({ collected: 53, limit: 50 }))).toEqual({
      stop: true,
      reason: "limit_reached"
    });
  });

  it("stops after the configured number of consecutive zero-new-card scrolls", () => {
    expect(
      evaluateStopCondition(
        makeState({ collected: 12, limit: 50, consecutiveStagnantScrolls: 3, noNewCardThreshold: 3 })
      )
    ).toEqual({ stop: true, reason: "no_new_cards" });

    // One short of the threshold: keep scrolling.
    expect(
      evaluateStopCondition(
        makeState({ collected: 12, limit: 50, consecutiveStagnantScrolls: 2, noNewCardThreshold: 3 })
      )
    ).toEqual({ stop: false });
  });

  it("stops when the max scroll budget is exhausted", () => {
    expect(
      evaluateStopCondition(makeState({ scrollAttempts: 60, maxScrollAttempts: 60 }))
    ).toEqual({ stop: true, reason: "max_scrolls" });
  });

  it("stops when the deadline has passed", () => {
    expect(
      evaluateStopCondition(makeState({ deadlineMs: 1000, nowMs: 1000 }))
    ).toEqual({ stop: true, reason: "timeout" });
    expect(
      evaluateStopCondition(makeState({ deadlineMs: 1000, nowMs: 999 }))
    ).toEqual({ stop: false });
  });

  it("anti-bot detections take precedence even when the limit was already reached", () => {
    expect(
      evaluateStopCondition(makeState({ collected: 50, limit: 50, captchaDetected: true }))
    ).toEqual({ stop: true, reason: "captcha" });
    expect(
      evaluateStopCondition(makeState({ collected: 50, limit: 50, softBlockDetected: true }))
    ).toEqual({ stop: true, reason: "soft_blocked" });
    // Captcha wins over soft-block when both flag simultaneously.
    expect(
      evaluateStopCondition(makeState({ captchaDetected: true, softBlockDetected: true }))
    ).toEqual({ stop: true, reason: "captcha" });
  });
});

describe("2GIS markers/clustered id parsing", () => {
  it("extracts the leading numeric firm id from a composite marker id", () => {
    expect(
      markerIdToFirmId(
        "70000001006434211_77h39yqcdBdB9A821J7H1J2JHGIIGH1Jctcoionu39-c17d00544A93I11674443-d8d50482465J28B3824856852I4JHJ2f8i3b78B8d33G4G2732000012H3J3HB193437i"
      )
    ).toBe("70000001006434211");
  });

  it("rejects ids whose leading run is shorter than the firm threshold (6 digits)", () => {
    expect(markerIdToFirmId("12345_77h39yqc...")).toBeNull();
    expect(markerIdToFirmId("1234_abc")).toBeNull();
  });

  it("rejects ids that do not start with a numeric run at all", () => {
    expect(markerIdToFirmId("branch_77h39yqc")).toBeNull();
    expect(markerIdToFirmId("[light] layer_77h")).toBeNull();
  });

  it("rejects empty / non-string inputs", () => {
    expect(markerIdToFirmId("")).toBeNull();
  });

  it("rejects composite ids that have a numeric prefix but no underscore", () => {
    // A bare numeric id without the `_...` suffix is the per-firm
    // shape, not a marker composite — it does not match the marker
    // pattern (this helper is marker-only).
    expect(markerIdToFirmId("70000001006434211")).toBeNull();
  });
});

describe("2GIS markers/clustered synthesis", () => {
  function makeItem(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "70000001006434211_77h39yqcdBdB9A821J7H1J2JHGIIGH1Jctcoionu39-c17d00544A93I11674443-d8d50482465J28B3824856852I4JHJ2f8i3b78B8d33G4G2732000012H3J3HB193437i",
      type: "branch",
      name: "Автоверсия",
      ...overrides
    };
  }

  it("returns an empty array when the payload has no result.items", () => {
    expect(synthesizeCardsFromMarkersPayload({}, "Автосервисы", "Новосибирск")).toEqual([]);
    expect(synthesizeCardsFromMarkersPayload({ result: {} }, "Автосервисы", "Новосибирск")).toEqual([]);
    expect(synthesizeCardsFromMarkersPayload({ result: { items: "not an array" } }, "Автосервисы", "Новосибирск")).toEqual([]);
  });

  it("synthesizes a card with the leading-numeric firm id and the visible name", () => {
    const payload = { result: { items: [makeItem({})] } };
    const cards = synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      externalId: "70000001006434211",
      name: "Автоверсия",
      url: ""
    });
  });

  it("preserves order and dedupes duplicate firm ids inside one payload", () => {
    const payload = {
      result: {
        items: [
          makeItem({ name: "Автоверсия" }),
          makeItem({ name: "Автоверсия — другое название" }),
          makeItem({ id: "70000001036934908_77h39yqc-zzz", name: "АРВ-сервис" })
        ]
      }
    };
    const cards = synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск");
    expect(cards.map((c) => c.externalId)).toEqual([
      "70000001006434211",
      "70000001036934908"
    ]);
    expect(cards[0].name).toBe("Автоверсия"); // first occurrence wins
  });

  it("rejects items without a parseable composite id", () => {
    const payload = {
      result: {
        items: [
          makeItem({ id: "branch_only" }),
          makeItem({ id: "" }),
          makeItem({ id: 12345 }) // not a string
        ]
      }
    };
    expect(synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск")).toEqual([]);
  });

  it("rejects items with empty / blank name", () => {
    const payload = {
      result: { items: [makeItem({ name: "" }), makeItem({ name: "   " })] }
    };
    expect(synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск")).toEqual([]);
  });

  it("rejects ad / cluster markers so paid placements never become firm cards", () => {
    const payload = {
      result: {
        items: [
          makeItem({ is_advertising: true, name: "РекламныйАвто" }),
          makeItem({ has_ads_model: true, name: "SponsoredАвто" }),
          makeItem({ cluster: { count: 5 }, name: "ClusterPin" }),
          makeItem({}) // genuine firm
        ]
      }
    };
    const cards = synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск");
    expect(cards.map((c) => c.name)).toEqual(["Автоверсия"]);
  });

  it("rejects junk-name rows (mirroring mapper JUNK_NAME_PATTERNS)", () => {
    const payload = {
      result: {
        items: [
          makeItem({ name: "[light] Фон со статичной текстурой" }),
          makeItem({ name: "Глобальная карта" }),
          makeItem({ name: "Данные и технологии 2ГИС для бизнеса" }),
          makeItem({}) // genuine
        ]
      }
    };
    const cards = synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск");
    expect(cards.map((c) => c.name)).toEqual(["Автоверсия"]);
  });

  it("trims surrounding whitespace from names and does not mutate the input payload", () => {
    const item = makeItem({ name: "  Автоверсия  " });
    const payload = { result: { items: [item] } };
    const before = JSON.stringify(payload);
    const cards = synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск");
    expect(cards[0].name).toBe("Автоверсия");
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("returned shape matches FirmCardCandidate so mergeCandidates accepts it directly", () => {
    const payload = { result: { items: [makeItem({})] } };
    const cards = synthesizeCardsFromMarkersPayload(payload, "Автосервисы", "Новосибирск");
    const merged = mergeCandidates([], cards);
    expect(merged.added).toBe(1);
    expect(merged.duplicates).toBe(0);
    expect(merged.merged).toEqual([
      { externalId: "70000001006434211", name: "Автоверсия", url: "" }
    ]);
  });
});
