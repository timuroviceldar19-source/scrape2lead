import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectPlanSearch, type PlanSearchPage } from "../../src/kz/goszakupPlanCollector.js";
import {
  buildPlanSearchUrl,
  extractCustomerUrl,
  matchesKeyword,
  parseGoszakupPagination,
  parseGoszakupPlanDetailHtml,
  parseGoszakupPlanSearchHtml
} from "../../src/kz/goszakupPlanHtmlParser.js";
import { mapApiPlanDetail } from "../../src/kz/goszakupPlanClient.js";

const FIXTURES = path.resolve("tests/fixtures");

describe("buildPlanSearchUrl", () => {
  it("builds registry plan search URL with filters", () => {
    const url = buildPlanSearchUrl({
      keyword: "Панель интерактивная",
      year: 2026,
      months: [6, 7, 8]
    });
    expect(url).toContain("filter%5Bname%5D=");
    expect(url).toContain("filter%5Byear%5D%5B%5D=2026");
    expect(url).toContain("filter%5Bmonth%5D%5B%5D=6");
    expect(url).toContain("count_record=50");
    expect(url).not.toContain("filter%5Bstatus%5D");
  });

  it("parses fixture HTML from URL without status filter", () => {
    const url = buildPlanSearchUrl({
      keyword: "Панель интерактивная",
      year: 2026,
      months: [6, 7, 8]
    });
    expect(url).not.toContain("filter%5Bstatus%5D");
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-plan-search.html"), "utf8");
    expect(parseGoszakupPlanSearchHtml(html, "Панель интерактивная")).toHaveLength(3);
  });
});

describe("parseGoszakupPagination", () => {
  it("parses total count and pages from plan search debug HTML", () => {
    const debugPath = path.resolve("data/debug/goszakup-plan-search-панель-интерактивная-page0.html");
    if (!fs.existsSync(debugPath)) return;

    const html = fs.readFileSync(debugPath, "utf8");
    const pagination = parseGoszakupPagination(html);

    expect(pagination.totalCount).toBeGreaterThan(0);
    expect(pagination.totalPages).toBeGreaterThanOrEqual(2);
  });
});

describe("parseGoszakupPlanSearchHtml", () => {
  it("parses plan list rows from fixture", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-plan-search.html"), "utf8");
    const items = parseGoszakupPlanSearchHtml(html, "Панель интерактивная");

    expect(items).toHaveLength(3);
    expect(items[0].plan_list_number).toBe("87156652");
    expect(items[0].plan_point_id).toBe("4797958");
    expect(items[0].item_name).toBe("Панель интерактивная");
    expect(items[0].quantity).toBe("2");
    expect(items[0].unit_price).toBe("646 551.00");
    expect(items[0].unit).toBe("Штука");
    expect(items[0].planned_month).toBe("Июнь");
    expect(items[0].status).toBe("Утвержден");
    expect(items[0].detail_url).toBe("https://goszakup.gov.kz/ru/registry/show_plan/87230655/4797958");
    expect(items[0].customer_url).toBe("https://goszakup.gov.kz/ru/registry/show_supplier/39345");
    expect(items[1].planned_month).toBe("Август");
  });

  it("extracts customer URL from row html", () => {
    const row = '<td><a href="https://goszakup.gov.kz/ru/registry/show_supplier/60283">Customer</a></td>';
    expect(extractCustomerUrl(row)).toBe("https://goszakup.gov.kz/ru/registry/show_supplier/60283");
  });

  it("returns empty array for empty results", () => {
    const html = `
      <table id="search-result">
        <tbody>
          <tr role="row"><td class="dataTables_empty">Ничего не найдено</td></tr>
        </tbody>
      </table>
    `;
    expect(parseGoszakupPlanSearchHtml(html, "test")).toHaveLength(0);
  });
});

describe("collectPlanSearch", () => {
  const emptySearchHtml = `
    <table id="search-result">
      <tbody>
        <tr role="row"><td class="dataTables_empty">Nothing found</td></tr>
      </tbody>
    </table>
  `;

  it("retries a search page load before parsing the page", async () => {
    let attempts = 0;
    const page: PlanSearchPage = {
      async goto() {
        attempts++;
        if (attempts === 1) throw new Error("Timeout 30000ms exceeded");
      },
      async waitForTimeout() {},
      async content() {
        return emptySearchHtml;
      }
    };

    const items = await collectPlanSearch(page, "https://example.test/registry/plan", "Ноутбук", {
      debugDir: path.join("data", "debug-test"),
      maxPages: 1,
      pageLoadTimeoutMs: 90_000,
      delayMs: 0,
      allowedStatusNames: [],
      pageLoadRetries: 2
    });

    expect(items).toHaveLength(0);
    expect(attempts).toBe(2);
  });

  it("throws after search page retries are exhausted", async () => {
    let attempts = 0;
    const page: PlanSearchPage = {
      async goto() {
        attempts++;
        throw new Error("Timeout 90000ms exceeded");
      },
      async waitForTimeout() {},
      async content() {
        return emptySearchHtml;
      }
    };

    await expect(
      collectPlanSearch(page, "https://example.test/registry/plan", "Ноутбук", {
        debugDir: path.join("data", "debug-test"),
        maxPages: 1,
        pageLoadTimeoutMs: 90_000,
        delayMs: 0,
        allowedStatusNames: [],
        pageLoadRetries: 2
      })
    ).rejects.toThrow(/Timeout 90000ms exceeded/);
    expect(attempts).toBe(3);
  });
});

describe("parseGoszakupPlanDetailHtml", () => {
  it("parses plan detail fields from fixture", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-plan-detail.html"), "utf8");
    const detail = parseGoszakupPlanDetailHtml(html, "4797958");

    expect(detail).not.toBeNull();
    expect(detail!.customer_bin).toBe("140540002824");
    expect(detail!.ref_enstru_code).toBe("262011.000.000002");
    expect(detail!.name_ru).toBe("Панель интерактивная");
    expect(detail!.desc_ru).toContain("75 дюймов");
    expect(detail!.extra_desc_ru).toContain("монтаж");
    expect(detail!.date_approved).toBe("2026-01-15");
    expect(detail!.abp_name).toBe("Министерство просвещения РК");
    expect(detail!.delivery_address).toContain("Сарань");
  });

  it("returns null for maintenance page", () => {
    const html = "<html><body>На веб-портале ведутся технические работы</body></html>";
    expect(parseGoszakupPlanDetailHtml(html, "1")).toBeNull();
  });
});

describe("matchesKeyword", () => {
  it("matches keyword case-insensitively", () => {
    expect(matchesKeyword("Панель интерактивная", "панель интерактивная")).toBe(true);
    expect(matchesKeyword("Доска обрезная", "Доска специальная")).toBe(false);
  });
});

describe("mapApiPlanDetail", () => {
  it("maps API payload to plan detail", () => {
    const detail = mapApiPlanDetail("4797958", {
      subject_biin: "140540002824",
      name_ru: "Панель интерактивная",
      ref_enstru_code: "262011.000.000002",
      desc_ru: "75 дюймов",
      extra_desc_ru: "Монтаж",
      date_approved: "2026-01-15 00:00:00",
      ref_abp_code: 208,
      plan_act_number: "12",
      kato: [{ full_delivery_place_name_ru: "г. Сарань" }]
    });

    expect(detail.customer_bin).toBe("140540002824");
    expect(detail.ref_enstru_code).toBe("262011.000.000002");
    expect(detail.date_approved).toBe("2026-01-15");
    expect(detail.delivery_address).toBe("г. Сарань");
  });
});
