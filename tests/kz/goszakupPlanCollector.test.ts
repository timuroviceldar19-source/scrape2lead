import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFallbackPlanDetail,
  collectPlanDetails,
  prefilterPlanListItems,
  type PlanSearchPage
} from "../../src/kz/goszakupPlanCollector.js";
import { KzStorage } from "../../src/kz/kzStorage.js";
import type { GoszakupPlanDetail, GoszakupPlanListItem } from "../../src/kz/goszakupPlanTypes.js";

function listItem(overrides: Partial<GoszakupPlanListItem> = {}): GoszakupPlanListItem {
  return {
    plan_point_id: "100200",
    plan_list_number: "500",
    customer_name: "Школа №1",
    customer_url: null,
    item_name: "Панель интерактивная",
    method: null,
    unit: null,
    quantity: null,
    unit_price: null,
    planned_amount: "1 500 000",
    planned_month: null,
    status: "Утвержден",
    detail_url: null,
    keyword: "Панель интерактивная",
    ...overrides
  };
}

function planDetail(overrides: Partial<GoszakupPlanDetail> = {}): GoszakupPlanDetail {
  return {
    plan_point_id: "100200",
    customer_bin: "123456789012",
    customer_name: "Школа №1",
    name_ru: "Панель интерактивная",
    ref_enstru_code: "262011.100.000001",
    desc_ru: null,
    extra_desc_ru: null,
    date_approved: null,
    ref_abp_code: null,
    abp_name: null,
    delivery_address: null,
    plan_act_number: null,
    ...overrides
  };
}

class FakePage implements PlanSearchPage {
  gotoCalls = 0;
  waitCalls = 0;
  constructor(private readonly html: string) {}
  async goto(): Promise<unknown> {
    this.gotoCalls++;
    return null;
  }
  async waitForTimeout(): Promise<unknown> {
    this.waitCalls++;
    return null;
  }
  async content(): Promise<string> {
    return this.html;
  }
}

describe("prefilterPlanListItems", () => {
  it("drops rows with a parseable amount below min but keeps empty/zero/unparseable", () => {
    const items = [
      listItem({ plan_point_id: "a", planned_amount: "500 000" }),   // below → drop
      listItem({ plan_point_id: "b", planned_amount: "2 000 000" }), // above → keep
      listItem({ plan_point_id: "c", planned_amount: null }),         // empty → keep
      listItem({ plan_point_id: "d", planned_amount: "0" }),          // zero → keep
      listItem({ plan_point_id: "e", planned_amount: "договорная" })  // unparseable → keep
    ];

    const result = prefilterPlanListItems(items, 1_000_000, []);

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["b", "c", "d", "e"]);
    expect(result.droppedBelowMinAmount).toBe(1);
    expect(result.droppedByName).toBe(0);
  });

  it("drops stop-listed names but never drops rows with an empty name", () => {
    const items = [
      listItem({ plan_point_id: "a", item_name: "Калькулятор инженерный", planned_amount: "2 000 000" }),
      listItem({ plan_point_id: "b", item_name: null, planned_amount: "2 000 000" }),
      listItem({ plan_point_id: "c", item_name: "Панель интерактивная", planned_amount: "2 000 000" })
    ];

    const result = prefilterPlanListItems(items, 0, ["Калькулятор"]);

    expect(result.items.map((item) => item.plan_point_id)).toEqual(["b", "c"]);
    expect(result.droppedByName).toBe(1);
  });

  it("keeps everything when no filters are configured", () => {
    const items = [listItem({ plan_point_id: "a" }), listItem({ plan_point_id: "b" })];
    expect(prefilterPlanListItems(items, 0, []).items).toHaveLength(2);
  });
});

describe("collectPlanDetails caching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves a cache hit without navigation or delay", async () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupPlanDetail(planDetail(), new Date().toISOString());
    const page = new FakePage("");
    const sleepImpl = vi.fn(async () => {});

    const { items, stats } = await collectPlanDetails(page, [listItem()], {
      debugDir: "data/debug-test",
      pageLoadTimeoutMs: 1000,
      delayMs: 2000,
      storage,
      sleepImpl
    });

    expect(page.gotoCalls).toBe(0);
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(items[0].detail?.ref_enstru_code).toBe("262011.100.000001");
    expect(stats).toMatchObject({ cacheHit: 1, cacheMiss: 0, fetched: 0, fetchFailed: 0 });
  });

  it("fetches on a cache miss, applies the delay, and does not cache a failed parse", async () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    const page = new FakePage("<html><body>no detail here</body></html>");
    const sleepImpl = vi.fn(async () => {});

    const { items, stats } = await collectPlanDetails(page, [listItem()], {
      debugDir: "data/debug-test",
      pageLoadTimeoutMs: 1000,
      delayMs: 5,
      storage,
      sleepImpl
    });

    expect(page.gotoCalls).toBeGreaterThan(0);
    expect(sleepImpl).toHaveBeenCalledWith(5);
    // Fallback detail is returned but never persisted.
    expect(items[0].detail?.customer_bin).toBeNull();
    expect(stats).toMatchObject({ cacheMiss: 1, fetched: 0, fetchFailed: 1 });
    expect(storage.getFreshGoszakupPlanDetail("100200", 3)).toBeNull();
  });

  it("bypasses the cache and re-fetches when forceRefresh is set", async () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    storage.upsertGoszakupPlanDetail(planDetail(), new Date().toISOString());
    const page = new FakePage("<html><body>no detail</body></html>");
    const sleepImpl = vi.fn(async () => {});

    await collectPlanDetails(page, [listItem()], {
      debugDir: "data/debug-test",
      pageLoadTimeoutMs: 1000,
      delayMs: 5,
      storage,
      forceRefresh: true,
      sleepImpl
    });

    expect(page.gotoCalls).toBeGreaterThan(0);
  });

  it("keeps the delay after an API fetch and caches the parsed detail", async () => {
    const db = new Database(":memory:");
    const storage = new KzStorage({ db });
    const page = new FakePage("");
    const sleepImpl = vi.fn(async () => {});

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ name_ru: "Панель интерактивная", subject_biin: "123456789012", ref_enstru_code: "262011.100.000001" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));

    const { items, stats } = await collectPlanDetails(page, [listItem()], {
      debugDir: "data/debug-test",
      pageLoadTimeoutMs: 1000,
      delayMs: 2000,
      storage,
      token: "test-token",
      sleepImpl
    });

    expect(page.gotoCalls).toBe(0); // API path, no browser navigation
    expect(sleepImpl).toHaveBeenCalledWith(2000);
    expect(items[0].detail?.customer_bin).toBe("123456789012");
    expect(stats).toMatchObject({ cacheMiss: 1, fetched: 1, fetchFailed: 0 });
    expect(storage.getFreshGoszakupPlanDetail("100200", 3)).not.toBeNull();
  });
});

describe("buildFallbackPlanDetail", () => {
  it("carries the list item name and customer but no enrichment", () => {
    const detail = buildFallbackPlanDetail(listItem());
    expect(detail).toMatchObject({
      plan_point_id: "100200",
      name_ru: "Панель интерактивная",
      customer_name: "Школа №1",
      customer_bin: null,
      ref_enstru_code: null
    });
  });
});
