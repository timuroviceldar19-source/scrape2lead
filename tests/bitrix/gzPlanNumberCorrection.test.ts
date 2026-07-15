import { describe, expect, it, vi } from "vitest";
import { hashGzPlanPage } from "../../src/kz/gzCanonicalPlanPage.js";
import {
  canExecuteGzPlanNumberCorrection,
  classifyGzPlanNumberCorrection,
  decideGzPlanNumberCorrectionWrite,
  detectGzPlanControlDrift,
  executeGzPlanNumberCorrection,
  planGzPlanNumberReplacements,
  readGzPlanControlFields,
  summarizeGzPlanNumberCorrection,
  type GzPlanNumberCorrectionEntry,
  type GzPlanNumberCorrectionIo,
  type GzPlanNumberCorrectionLoad,
  type GzPlanNumberCorrectionReport
} from "../../src/bitrix/gzPlanNumberCorrection.js";
import type { GzBackfillDeal } from "../../src/bitrix/gzPlanNumberBackfill.js";

// Deal 38807: canonical point 87018653, legacy segment 4775438 shared with deal 41719
// (point 87018811). The 20260715 backfill read one page for both and wrote 81211733.
const POINT = "87018653";
const SIBLING_POINT = "87018811";
const URL = `https://goszakup.gov.kz/ru/registry/show_plan/${POINT}/4775438`;
const SIBLING_URL = `https://goszakup.gov.kz/ru/registry/show_plan/${SIBLING_POINT}/4775438`;

const LIVE_PAGE = "<div><h3>84990112: Монитор</h3></div>";
const STORED_NUMBER = "81211733";
const LIVE_NUMBER = "84990112";

function makeDeal(overrides: Partial<GzBackfillDeal> = {}): GzBackfillDeal {
  return {
    ID: "38807",
    TITLE: "Монитор",
    CATEGORY_ID: "41",
    ORIGIN_ID: "gz-plan:87018653",
    ORIGINATOR_ID: "scrape2lead-gz-plans",
    STAGE_ID: "C41:EXECUTING",
    UF_CRM_PLAN_ID: STORED_NUMBER,
    UF_CRM_PLAN_LINK: URL,
    ...overrides
  };
}

function makeLoad(overrides: Partial<GzPlanNumberCorrectionLoad> = {}): GzPlanNumberCorrectionLoad {
  return {
    dealId: "38807",
    canonicalPlanPointId: POINT,
    requestedUrl: URL,
    finalUrl: URL,
    html: LIVE_PAGE,
    ...overrides
  };
}

function makeEntry(overrides: Partial<GzPlanNumberCorrectionEntry> = {}): GzPlanNumberCorrectionEntry {
  return {
    dealId: "38807",
    canonicalPlanPointId: POINT,
    requestedUrl: URL,
    finalUrl: URL,
    pageHash: hashGzPlanPage(LIVE_PAGE),
    storedPlanNumber: STORED_NUMBER,
    livePlanNumber: LIVE_NUMBER,
    verdict: "wrong",
    control: readGzPlanControlFields(makeDeal()),
    ...overrides
  };
}

function makeReport(overrides: Partial<GzPlanNumberCorrectionReport> = {}): GzPlanNumberCorrectionReport {
  return {
    schemaVersion: 2,
    createdAt: "2026-07-15T12:00:00.000Z",
    sourceReport: "data/gz-plan-number-backfill-20260715-091207.json",
    verified: [makeEntry()],
    unresolved: [],
    ...overrides
  };
}

describe("readGzPlanControlFields", () => {
  it("captures the fields the correction must leave alone", () => {
    const control = readGzPlanControlFields(makeDeal());

    expect(control).toEqual({
      TITLE: "Монитор",
      CATEGORY_ID: "41",
      STAGE_ID: "C41:EXECUTING",
      ORIGINATOR_ID: "scrape2lead-gz-plans",
      ORIGIN_ID: "gz-plan:87018653",
      UF_CRM_PLAN_LINK: URL
    });
  });

  it("never captures the field being corrected", () => {
    expect(readGzPlanControlFields(makeDeal())).not.toHaveProperty("UF_CRM_PLAN_ID");
  });
});

describe("classifyGzPlanNumberCorrection", () => {
  it("calls a deal wrong when the canonical page contradicts the stored number", () => {
    const result = classifyGzPlanNumberCorrection(makeLoad(), makeDeal());

    expect(result).toEqual({
      entry: {
        dealId: "38807",
        canonicalPlanPointId: POINT,
        requestedUrl: URL,
        finalUrl: URL,
        pageHash: hashGzPlanPage(LIVE_PAGE),
        storedPlanNumber: STORED_NUMBER,
        livePlanNumber: LIVE_NUMBER,
        verdict: "wrong",
        control: readGzPlanControlFields(makeDeal())
      }
    });
  });

  it("calls a deal unchanged when the canonical page confirms the stored number", () => {
    const result = classifyGzPlanNumberCorrection(makeLoad(), makeDeal({ UF_CRM_PLAN_ID: LIVE_NUMBER }));

    expect(result).toMatchObject({ entry: { verdict: "unchanged", livePlanNumber: LIVE_NUMBER } });
  });

  it("records both the old and the live value so the report can be audited", () => {
    const result = classifyGzPlanNumberCorrection(makeLoad(), makeDeal()) as {
      entry: GzPlanNumberCorrectionEntry;
    };

    expect(result.entry.storedPlanNumber).toBe(STORED_NUMBER);
    expect(result.entry.livePlanNumber).toBe(LIVE_NUMBER);
  });

  it("leaves a deal unresolved when the page redirected to the sibling point", () => {
    const result = classifyGzPlanNumberCorrection(makeLoad({ finalUrl: SIBLING_URL }), makeDeal());

    expect(result).toMatchObject({ unresolved: { dealId: "38807" } });
    expect((result as { unresolved: { reason: string } }).unresolved.reason).toContain(SIBLING_POINT);
  });

  it("leaves a deal unresolved when the page never loaded", () => {
    const result = classifyGzPlanNumberCorrection(
      makeLoad({ html: null, loadError: "net::ERR_TIMED_OUT" }),
      makeDeal()
    );

    expect((result as { unresolved: { reason: string } }).unresolved.reason).toContain("net::ERR_TIMED_OUT");
  });

  it("leaves a deal unresolved on a maintenance page carrying no plan heading", () => {
    const result = classifyGzPlanNumberCorrection(
      makeLoad({ html: "<html><body><h1>Ведутся технические работы</h1></body></html>" }),
      makeDeal()
    );

    expect(result).toMatchObject({ unresolved: { canonicalPlanPointId: POINT } });
  });

  it("leaves a deal unresolved when the page offers two different numbers", () => {
    const ambiguous = "<h3>84990112: Монитор</h3><h3>81211733: Доска</h3>";
    const result = classifyGzPlanNumberCorrection(makeLoad({ html: ambiguous }), makeDeal());

    expect(result).toHaveProperty("unresolved");
  });
});

describe("summarizeGzPlanNumberCorrection", () => {
  it("partitions the set into verified (wrong + unchanged) and unresolved", () => {
    const report = makeReport({
      verified: [makeEntry(), makeEntry({ dealId: "38808", verdict: "unchanged" })],
      unresolved: [
        { dealId: "38809", canonicalPlanPointId: POINT, requestedUrl: URL, finalUrl: "", reason: "timeout" }
      ]
    });

    expect(summarizeGzPlanNumberCorrection(report)).toEqual({
      verified: 2,
      wrong: 1,
      unchanged: 1,
      unresolved: 1
    });
  });
});

describe("planGzPlanNumberReplacements", () => {
  it("lists only the deals whose stored number the canonical page contradicts", () => {
    const report = makeReport({ verified: [makeEntry(), makeEntry({ dealId: "38808", verdict: "unchanged" })] });

    expect(planGzPlanNumberReplacements(report).map((entry) => entry.dealId)).toEqual(["38807"]);
  });
});

describe("canExecuteGzPlanNumberCorrection", () => {
  it("allows execute once every deal is verified", () => {
    expect(canExecuteGzPlanNumberCorrection(makeReport()).ok).toBe(true);
  });

  it("blocks execute while any deal is unresolved", () => {
    const verdict = canExecuteGzPlanNumberCorrection(
      makeReport({
        unresolved: [
          { dealId: "38809", canonicalPlanPointId: POINT, requestedUrl: URL, finalUrl: "", reason: "timeout" }
        ]
      })
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("38809");
  });

  it("blocks execute on an empty report", () => {
    expect(canExecuteGzPlanNumberCorrection(makeReport({ verified: [] })).ok).toBe(false);
  });

  it("allows an execute that has nothing left to replace, so a re-run only skips", () => {
    const report = makeReport({ verified: [makeEntry({ verdict: "unchanged" })] });

    expect(canExecuteGzPlanNumberCorrection(report).ok).toBe(true);
  });
});

describe("detectGzPlanControlDrift", () => {
  it("passes an untouched deal", () => {
    expect(detectGzPlanControlDrift(makeEntry(), makeDeal())).toBeNull();
  });

  it("names the field a human moved since the report", () => {
    expect(detectGzPlanControlDrift(makeEntry(), makeDeal({ STAGE_ID: "C41:WON" }))).toContain("STAGE_ID");
    expect(detectGzPlanControlDrift(makeEntry(), makeDeal({ UF_CRM_PLAN_LINK: SIBLING_URL }))).toContain(
      "UF_CRM_PLAN_LINK"
    );
    expect(detectGzPlanControlDrift(makeEntry(), makeDeal({ TITLE: "Монитор 27" }))).toContain("TITLE");
  });
});

describe("decideGzPlanNumberCorrectionWrite", () => {
  const reload = { finalUrl: URL, html: LIVE_PAGE };

  it("writes the live number over the wrong one when the fresh load agrees with the report", () => {
    expect(decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal(), reload)).toEqual({
      action: "write",
      fields: { UF_CRM_PLAN_ID: LIVE_NUMBER }
    });
  });

  it("touches nothing but the plan number field", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal(), reload);

    expect(Object.keys(decision.fields ?? {})).toEqual(["UF_CRM_PLAN_ID"]);
  });

  it("skips a deal the canonical page already confirmed", () => {
    const entry = makeEntry({ verdict: "unchanged", storedPlanNumber: LIVE_NUMBER });
    const decision = decideGzPlanNumberCorrectionWrite(entry, makeDeal({ UF_CRM_PLAN_ID: LIVE_NUMBER }));

    expect(decision.action).toBe("skip");
  });

  it("skips a deal already corrected, so a repeated execute writes nothing", () => {
    const decision = decideGzPlanNumberCorrectionWrite(
      makeEntry(),
      makeDeal({ UF_CRM_PLAN_ID: LIVE_NUMBER }),
      reload
    );

    expect(decision.action).toBe("skip");
  });

  it("blocks a write when a control field drifted since the report", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal({ STAGE_ID: "C41:WON" }), reload);

    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain("STAGE_ID");
  });

  it("blocks a write when the deal's number changed to something the report never saw", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal({ UF_CRM_PLAN_ID: "70000001" }), reload);

    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain("70000001");
  });

  it("blocks a write when no fresh load backs the report", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal());

    expect(decision.action).toBe("blocked");
  });

  it("blocks a write when the fresh load disagrees with the report", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal(), {
      finalUrl: URL,
      html: "<h3>70000001: Монитор</h3>"
    });

    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain("70000001");
  });

  it("blocks a write when the fresh load redirected to the sibling point", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal(), {
      finalUrl: SIBLING_URL,
      html: LIVE_PAGE
    });

    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain(SIBLING_POINT);
  });

  it("blocks a write when the fresh load failed", () => {
    const decision = decideGzPlanNumberCorrectionWrite(makeEntry(), makeDeal(), { finalUrl: URL, html: null });

    expect(decision.action).toBe("blocked");
  });
});

describe("executeGzPlanNumberCorrection", () => {
  const SECOND_PAGE = "<div><h3>81205554: Доска</h3></div>";
  const SECOND_STORED = "81211733";
  const SECOND_LIVE = "81205554";

  function secondDeal(overrides: Partial<GzBackfillDeal> = {}): GzBackfillDeal {
    return makeDeal({
      ID: "38808",
      ORIGIN_ID: "gz-plan:87018811",
      UF_CRM_PLAN_LINK: SIBLING_URL,
      UF_CRM_PLAN_ID: SECOND_STORED,
      ...overrides
    });
  }

  function secondEntry(overrides: Partial<GzPlanNumberCorrectionEntry> = {}): GzPlanNumberCorrectionEntry {
    return makeEntry({
      dealId: "38808",
      canonicalPlanPointId: SIBLING_POINT,
      requestedUrl: SIBLING_URL,
      finalUrl: SIBLING_URL,
      pageHash: hashGzPlanPage(SECOND_PAGE),
      storedPlanNumber: SECOND_STORED,
      livePlanNumber: SECOND_LIVE,
      control: readGzPlanControlFields(secondDeal()),
      ...overrides
    });
  }

  function makeIo(
    deals: Record<string, GzBackfillDeal | null>,
    pages: Record<string, string | null> = { [URL]: LIVE_PAGE, [SIBLING_URL]: SECOND_PAGE }
  ): { io: GzPlanNumberCorrectionIo; updateDeal: ReturnType<typeof vi.fn>; readDeal: ReturnType<typeof vi.fn> } {
    const updateDeal = vi.fn(async () => {});
    const readDeal = vi.fn(async (dealId: string) => deals[dealId] ?? null);
    return {
      io: {
        readDeal,
        loadCanonicalPage: vi.fn(async (url: string) => ({ finalUrl: url, html: pages[url] ?? null })),
        updateDeal
      },
      updateDeal,
      readDeal
    };
  }

  it("writes nothing at all when a later replacement is blocked", async () => {
    // The block sits on the second deal: the first must not already be rewritten.
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo({
      "38807": makeDeal(),
      "38808": secondDeal({ STAGE_ID: "C41:WON" })
    });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome.written).toBe(0);
    expect(outcome.blocked.join(" ")).toContain("38808");
  });

  it("writes every replacement once the whole preflight is green", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo({ "38807": makeDeal(), "38808": secondDeal() });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(outcome.written).toBe(2);
    expect(outcome.blocked).toEqual([]);
    expect(updateDeal.mock.calls).toEqual([
      ["38807", { UF_CRM_PLAN_ID: LIVE_NUMBER }],
      ["38808", { UF_CRM_PLAN_ID: SECOND_LIVE }]
    ]);
  });

  it("writes nothing when one canonical page fails to load", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo(
      { "38807": makeDeal(), "38808": secondDeal() },
      { [URL]: LIVE_PAGE, [SIBLING_URL]: null }
    );

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome.written).toBe(0);
  });

  it("writes nothing when a canonical load throws", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo({ "38807": makeDeal(), "38808": secondDeal() });
    io.loadCanonicalPage = vi.fn(async (url: string) => {
      if (url === SIBLING_URL) throw new Error("net::ERR_TIMED_OUT");
      return { finalUrl: url, html: LIVE_PAGE };
    });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome.written).toBe(0);
    expect(outcome.blocked.join(" ")).toContain("net::ERR_TIMED_OUT");
  });

  it("writes nothing when one deal can no longer be read", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo({ "38807": makeDeal(), "38808": null });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome.written).toBe(0);
    expect(outcome.blocked.join(" ")).toContain("38808");
  });

  it("writes nothing when a read throws", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo({ "38807": makeDeal(), "38808": secondDeal() });
    io.readDeal = vi.fn(async (dealId: string) => {
      if (dealId === "38808") throw new Error("QUERY_LIMIT_EXCEEDED");
      return makeDeal();
    });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome.written).toBe(0);
    expect(outcome.blocked.join(" ")).toContain("QUERY_LIMIT_EXCEEDED");
  });

  it("refuses an unresolved report without reading or writing anything", async () => {
    const report = makeReport({
      verified: [makeEntry()],
      unresolved: [
        { dealId: "38809", canonicalPlanPointId: POINT, requestedUrl: URL, finalUrl: "", reason: "timeout" }
      ]
    });
    const { io, updateDeal, readDeal } = makeIo({ "38807": makeDeal() });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(readDeal).not.toHaveBeenCalled();
    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome.written).toBe(0);
  });

  it("only skips on a repeated run, writing nothing", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io, updateDeal } = makeIo({
      "38807": makeDeal({ UF_CRM_PLAN_ID: LIVE_NUMBER }),
      "38808": secondDeal({ UF_CRM_PLAN_ID: SECOND_LIVE })
    });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ written: 0, skipped: 2, blocked: [] });
  });

  it("counts a confirmed deal as skipped without reading or loading it", async () => {
    const report = makeReport({ verified: [makeEntry({ verdict: "unchanged", storedPlanNumber: LIVE_NUMBER })] });
    const { io, updateDeal, readDeal } = makeIo({ "38807": makeDeal() });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(readDeal).not.toHaveBeenCalled();
    expect(updateDeal).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ written: 0, skipped: 1 });
  });

  it("reports a failure mid-series without inventing a rollback", async () => {
    const report = makeReport({ verified: [makeEntry(), secondEntry()] });
    const { io } = makeIo({ "38807": makeDeal(), "38808": secondDeal() });
    io.updateDeal = vi.fn(async (dealId: string) => {
      if (dealId === "38808") throw new Error("net::ERR_CONNECTION_RESET");
    });

    const outcome = await executeGzPlanNumberCorrection(report, io);

    expect(outcome.written).toBe(1);
    expect(outcome.failed.join(" ")).toContain("38808");
  });
});
