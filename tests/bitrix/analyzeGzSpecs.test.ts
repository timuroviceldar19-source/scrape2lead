import { describe, expect, it, vi } from "vitest";
import {
  assertConfirmDealMatches,
  assertSafeInvocation,
  buildTimelineComment,
  isTargetMode,
  resolveTargetRows,
  sha256Hex,
  SpecDealClient,
  toDealRef,
  type CliArgs,
  type DealRef,
  type DealResolver,
  type GzLotRow
} from "../../scripts/analyze-gz-specs.mjs";
import type { SpecAnalysis } from "../../src/analysis/specAnalyzer.js";

const ANALYSIS: SpecAnalysis = {
  product: "Моноблоки для учебных кабинетов",
  summary: "Закупка 20 моноблоков с монитором 23.8\" для школы.",
  keyParams: ["Экран 23.8\"", "ОЗУ 8 ГБ"],
  quantity: "20 шт",
  deadline: "до 30 сентября 2026",
  supplierRequirements: ["Гарантия 12 мес"],
  fitVerdict: "можем",
  fitReason: "Стандартная компьютерная техника из нашего профиля.",
  risks: []
};

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    inputPath: "exports/test.xlsx",
    execute: false,
    limit: null,
    force: false,
    delayMs: 0,
    provider: null,
    baseUrl: null,
    model: null,
    fallbackBaseUrl: null,
    fallbackModel: undefined,
    webhookUrl: "https://example.bitrix24.kz/rest/1/token",
    dealId: null,
    lotNumberArg: null,
    confirmDealId: null,
    ...overrides
  };
}

function makeRow(overrides: Partial<GzLotRow> = {}): GzLotRow {
  return {
    rowNumber: 2,
    lotNumber: "82982126-ЗЦП1",
    lotName: "Компьютеры для школы",
    customer: "ГУ Школа №1",
    status: "опубликован",
    announceUrl: "https://goszakup.gov.kz/ru/announce/index/12345",
    ...overrides
  };
}

function makeDealRef(overrides: Partial<DealRef> = {}): DealRef {
  return {
    id: "41293",
    title: "GZ lot 82982126-ЗЦП1",
    analyzedAt: null,
    verdict: null,
    resultHash: null,
    pdfHash: null,
    ...overrides
  };
}

describe("assertSafeInvocation", () => {
  it("forbids --execute --force in batch mode (the incident this closes)", () => {
    expect(() => assertSafeInvocation(makeArgs({ execute: true, force: true }), false)).toThrow(
      /--execute --force without --deal-id\/--lot-number is disabled/
    );
  });

  it("allows --execute --force when a single deal is targeted with --confirm-deal", () => {
    expect(() =>
      assertSafeInvocation(makeArgs({ execute: true, force: true, confirmDealId: "41293" }), true)
    ).not.toThrow();
  });

  it("allows plain batch --execute without --force", () => {
    expect(() => assertSafeInvocation(makeArgs({ execute: true }), false)).not.toThrow();
  });

  it("requires --confirm-deal whenever a target is combined with --execute", () => {
    expect(() => assertSafeInvocation(makeArgs({ execute: true }), true)).toThrow(/requires --confirm-deal/);
  });

  it("does not require --confirm-deal for a dry-run against a target", () => {
    expect(() => assertSafeInvocation(makeArgs({ execute: false }), true)).not.toThrow();
  });
});

describe("assertConfirmDealMatches", () => {
  it("throws when --confirm-deal does not match the resolved deal", () => {
    expect(() => assertConfirmDealMatches("41293", "99999", "82982126-ЗЦП1")).toThrow(
      /does not match resolved deal 41293/
    );
  });

  it("throws when no deal was resolved at all", () => {
    expect(() => assertConfirmDealMatches(null, "41293", "82982126-ЗЦП1")).toThrow(/does not match resolved deal -/);
  });

  it("passes when --confirm-deal matches exactly", () => {
    expect(() => assertConfirmDealMatches("41293", "41293", "82982126-ЗЦП1")).not.toThrow();
  });
});

describe("isTargetMode", () => {
  it("is false for batch invocations", () => {
    expect(isTargetMode({ dealId: null, lotNumberArg: null })).toBe(false);
  });

  it("is true when either --deal-id or --lot-number is set", () => {
    expect(isTargetMode({ dealId: "41293", lotNumberArg: null })).toBe(true);
    expect(isTargetMode({ dealId: null, lotNumberArg: "82982126-ЗЦП1" })).toBe(true);
  });
});

describe("resolveTargetRows", () => {
  it("--deal-id resolves the exact deal and binds it to the matching row without re-searching by ORIGIN_ID", async () => {
    const rows = [makeRow(), makeRow({ rowNumber: 3, lotNumber: "other-lot" })];
    const getDealById = vi.fn(async () => ({
      ...makeDealRef(),
      originId: "gz-lot:82982126-ЗЦП1"
    }));
    const findDeal = vi.fn();
    const client: DealResolver = { findDeal, getDealById };

    const items = await resolveTargetRows(makeArgs({ dealId: "41293" }), rows, client);

    expect(items).toHaveLength(1);
    expect(items[0].dealId).toBe("41293");
    expect(items[0].row.lotNumber).toBe("82982126-ЗЦП1");
    expect(findDeal).not.toHaveBeenCalled();
  });

  it("--deal-id rejects a mismatching --lot-number instead of silently picking one", async () => {
    const rows = [makeRow()];
    const client: DealResolver = {
      findDeal: vi.fn(),
      getDealById: vi.fn(async () => ({ ...makeDealRef(), originId: "gz-lot:82982126-ЗЦП1" }))
    };

    await expect(
      resolveTargetRows(makeArgs({ dealId: "41293", lotNumberArg: "some-other-lot" }), rows, client)
    ).rejects.toThrow(/does not match deal 41293's lot/);
  });

  it("--deal-id throws when the local export has no row for the deal's lot", async () => {
    const rows = [makeRow({ lotNumber: "different-lot" })];
    const client: DealResolver = {
      findDeal: vi.fn(),
      getDealById: vi.fn(async () => ({ ...makeDealRef(), originId: "gz-lot:82982126-ЗЦП1" }))
    };

    await expect(resolveTargetRows(makeArgs({ dealId: "41293" }), rows, client)).rejects.toThrow(/not found in/);
  });

  it("--lot-number rejects ambiguous XLSX rows instead of processing all of them (the incident this closes)", async () => {
    const rows = [makeRow(), makeRow({ rowNumber: 3 })];
    const client: DealResolver = { findDeal: vi.fn(), getDealById: vi.fn() };

    await expect(
      resolveTargetRows(makeArgs({ lotNumberArg: "82982126-ЗЦП1" }), rows, client)
    ).rejects.toThrow(/matches 2 rows/);
  });

  it("--lot-number resolves the single matching deal up front", async () => {
    const rows = [makeRow()];
    const findDeal = vi.fn(async () => makeDealRef());
    const client: DealResolver = { findDeal, getDealById: vi.fn() };

    const items = await resolveTargetRows(makeArgs({ lotNumberArg: "82982126-ЗЦП1" }), rows, client);

    expect(items).toEqual([{ row: rows[0], dealId: "41293" }]);
    expect(findDeal).toHaveBeenCalledWith("gz-lot:82982126-ЗЦП1");
  });

  it("--lot-number throws when no Bitrix deal exists for the lot", async () => {
    const rows = [makeRow()];
    const client: DealResolver = { findDeal: vi.fn(async () => null), getDealById: vi.fn() };

    await expect(
      resolveTargetRows(makeArgs({ lotNumberArg: "82982126-ЗЦП1" }), rows, client)
    ).rejects.toThrow(/no Bitrix deal found/);
  });

  it("batch mode returns every row unresolved (dealId null), respecting --limit", async () => {
    const rows = [makeRow(), makeRow({ rowNumber: 3 }), makeRow({ rowNumber: 4 })];
    const client: DealResolver = { findDeal: vi.fn(), getDealById: vi.fn() };

    const items = await resolveTargetRows(makeArgs({ limit: 2 }), rows, client);

    expect(items).toEqual([
      { row: rows[0], dealId: null },
      { row: rows[1], dealId: null }
    ]);
  });
});

describe("SpecDealClient.findDeal", () => {
  it("throws on duplicate ORIGIN_ID matches instead of picking the first one", async () => {
    const call = vi.fn(async () => [{ ID: "1" }, { ID: "2" }]);
    const client = new SpecDealClient({ call });

    await expect(client.findDeal("gz-lot:82982126-ЗЦП1")).rejects.toThrow(/2 deals share ORIGIN_ID/);
  });

  it("returns null when no deal matches", async () => {
    const call = vi.fn(async () => []);
    const client = new SpecDealClient({ call });

    await expect(client.findDeal("gz-lot:82982126-ЗЦП1")).resolves.toBeNull();
  });
});

describe("SpecDealClient.getDealById", () => {
  it("rejects a deal belonging to a different ORIGINATOR_ID", async () => {
    const call = vi.fn(async () => ({ ID: "41293", ORIGINATOR_ID: "some-other-source" }));
    const client = new SpecDealClient({ call });

    await expect(client.getDealById("41293")).rejects.toThrow(/does not belong to scrape2lead-gz-lots/);
  });

  it("returns the deal with its ORIGIN_ID when it belongs to this originator", async () => {
    const call = vi.fn(async () => ({
      ID: "41293",
      TITLE: "GZ lot",
      ORIGINATOR_ID: "scrape2lead-gz-lots",
      ORIGIN_ID: "gz-lot:82982126-ЗЦП1"
    }));
    const client = new SpecDealClient({ call });

    await expect(client.getDealById("41293")).resolves.toMatchObject({
      id: "41293",
      originId: "gz-lot:82982126-ЗЦП1"
    });
  });
});

describe("SpecDealClient.hasCommentWithHash", () => {
  it("returns true when an existing timeline comment carries the same result-hash marker", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const call = vi.fn(async () => [{ ID: "9", COMMENT: `some text [i]hash:${resultHash.slice(0, 12)}[/i]` }]);
    const client = new SpecDealClient({ call });

    await expect(client.hasCommentWithHash("41293", resultHash)).resolves.toBe(true);
  });

  it("returns false when no comment carries the marker, so a failed post gets retried", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const call = vi.fn(async () => [{ ID: "9", COMMENT: "unrelated comment" }]);
    const client = new SpecDealClient({ call });

    await expect(client.hasCommentWithHash("41293", resultHash)).resolves.toBe(false);
  });

  it("pages past the first 50 comments instead of missing an older marker", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const marker = `hash:${resultHash.slice(0, 12)}`;
    const firstPage = Array.from({ length: 50 }, (_, i) => ({ ID: String(i), COMMENT: "unrelated" }));
    const secondPage = [{ ID: "999", COMMENT: `old ai note [i]${marker}[/i]` }];
    const call = vi.fn(async (_method: string, body?: unknown) => {
      const start = (body as { start?: number } | undefined)?.start ?? 0;
      return start === 0 ? firstPage : secondPage;
    });
    const client = new SpecDealClient({ call });

    await expect(client.hasCommentWithHash("41293", resultHash)).resolves.toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect((call.mock.calls[1][1] as { start?: number }).start).toBe(50);
  });

  it("stops as soon as a page comes back short of the page size", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const call = vi.fn(async () => [{ ID: "1", COMMENT: "unrelated" }]);
    const client = new SpecDealClient({ call });

    await expect(client.hasCommentWithHash("41293", resultHash)).resolves.toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("SpecDealClient.addTimelineCommentIdempotently", () => {
  it("skips posting when a comment with this result's marker already exists", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const marker = `hash:${resultHash.slice(0, 12)}`;
    const call = vi.fn(async (method: string) => {
      if (method === "crm.timeline.comment.list") return [{ ID: "1", COMMENT: `x ${marker}` }];
      throw new Error(`unexpected call: ${method}`);
    });
    const client = new SpecDealClient({ call });

    await expect(client.addTimelineCommentIdempotently("41293", "comment text", resultHash)).resolves.toBe(
      "already-existed"
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("posts once when no marker exists, disabling the shared client's automatic retry for the add itself", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const calls: Array<{ method: string; options?: { maxRetries?: number } }> = [];
    const call = vi.fn(async (method: string, _body?: unknown, options?: { maxRetries?: number }) => {
      calls.push({ method, options });
      return method === "crm.timeline.comment.list" ? [] : "42";
    });
    const client = new SpecDealClient({ call });

    await expect(client.addTimelineCommentIdempotently("41293", "comment text", resultHash)).resolves.toBe("posted");
    const addCall = calls.find((c) => c.method === "crm.timeline.comment.add");
    expect(addCall?.options).toEqual({ maxRetries: 0 });
  });

  it("re-checks the timeline instead of blindly retrying after an ambiguous add failure (response lost after success)", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const marker = `hash:${resultHash.slice(0, 12)}`;
    let listCallCount = 0;
    const call = vi.fn(async (method: string) => {
      if (method === "crm.timeline.comment.list") {
        listCallCount += 1;
        // 1st check: nothing posted yet. 2nd check, after the "ambiguous" add
        // failure: the comment actually landed, so it must be found now.
        return listCallCount === 1 ? [] : [{ ID: "1", COMMENT: `x ${marker}` }];
      }
      if (method === "crm.timeline.comment.add") throw new Error("response lost after comment was created");
      throw new Error(`unexpected call: ${method}`);
    });
    const client = new SpecDealClient({ call });

    await expect(client.addTimelineCommentIdempotently("41293", "comment text", resultHash)).resolves.toBe(
      "already-existed"
    );
    const addCalls = call.mock.calls.filter(([method]) => method === "crm.timeline.comment.add");
    expect(addCalls).toHaveLength(1);
  });

  it("throws the original error once retries are exhausted and the comment never actually lands", async () => {
    const resultHash = sha256Hex("analysis-v1");
    const call = vi.fn(async (method: string) => {
      if (method === "crm.timeline.comment.list") return [];
      if (method === "crm.timeline.comment.add") throw new Error("persistent network failure");
      throw new Error(`unexpected call: ${method}`);
    });
    const client = new SpecDealClient({ call });

    await expect(
      client.addTimelineCommentIdempotently("41293", "comment text", resultHash, 2)
    ).rejects.toThrow(/persistent network failure/);
  });
});

describe("buildTimelineComment", () => {
  it("embeds a marker derived from the result hash for idempotency checks", () => {
    const resultHash = sha256Hex(JSON.stringify(ANALYSIS));
    const comment = buildTimelineComment(ANALYSIS, "spec.pdf", resultHash);
    expect(comment).toContain(`hash:${resultHash.slice(0, 12)}`);
    expect(comment).toContain("МОЖЕМ");
  });
});

describe("sha256Hex", () => {
  it("is deterministic for identical input", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
  });

  it("differs for different input", () => {
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("toDealRef", () => {
  it("maps Bitrix fields, including the analysis hash fields, to a DealRef", () => {
    const deal = toDealRef({
      ID: "41293",
      TITLE: "GZ lot",
      UF_CRM_S2L_SPEC_ANALYZED_AT: "2026-07-01T00:00:00.000Z",
      UF_CRM_S2L_SPEC_VERDICT: "можем",
      UF_CRM_S2L_SPEC_RESULT_HASH: "deadbeef",
      UF_CRM_S2L_SPEC_PDF_HASH: "cafef00d"
    });

    expect(deal).toEqual({
      id: "41293",
      title: "GZ lot",
      analyzedAt: "2026-07-01T00:00:00.000Z",
      verdict: "можем",
      resultHash: "deadbeef",
      pdfHash: "cafef00d"
    });
  });
});
