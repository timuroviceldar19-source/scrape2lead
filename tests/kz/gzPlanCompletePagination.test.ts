import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPlanSearch, type PlanSearchPage } from "../../src/kz/goszakupPlanCollector.js";
import { loadGzPlansConfig, mergeGzPlansExportOptions } from "../../src/kz/gzPlansConfig.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gz-plan-pages-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function resultHtml(page: number, totalCount: number, recordsPerPage = 50, includeCount = true): string {
  const first = (page - 1) * recordsPerPage + 1;
  const last = Math.min(page * recordsPerPage, totalCount);
  const rows = Array.from({ length: last - first + 1 }, (_, offset) => {
    const id = first + offset;
    return `<tr><td><a href="/ru/registry/show_plan/${id}/4919286">${id}</a></td>
      <td>Заказчик</td><td>Компьютер</td><td>Открытый конкурс</td><td>Комплект</td>
      <td>1</td><td>500000</td><td>500000</td><td>Декабрь</td><td>Утвержден</td></tr>`;
  }).join("");
  return `${includeCount ? `<strong>Показано c ${first} по ${last} из ${totalCount} записей</strong>` : ""}
    <a href="?page=${Math.ceil(totalCount / recordsPerPage)}">Последняя</a>
    <table id="search-result"><tbody>${rows}</tbody></table>`;
}

function searchPage(totalCount: number, options: { emptyPage?: number; recordsPerPage?: number; includeCount?: boolean } = {}): { page: PlanSearchPage; urls: string[] } {
  let current = 1;
  const urls: string[] = [];
  return {
    urls,
    page: {
      async goto(url) {
        urls.push(url);
        current = Number(new URL(url).searchParams.get("page") ?? 1);
      },
      async waitForTimeout() {},
      async content() {
        return current === options.emptyPage
          ? '<table id="search-result"><tbody></tbody></table>'
          : resultHtml(current, totalCount, options.recordsPerPage, options.includeCount);
      }
    }
  };
}

describe("complete GZ plan pagination", () => {
  it("collects the last record beyond page 50 without an explicit limit", async () => {
    const { page, urls } = searchPage(2501);
    const items = await collectPlanSearch(page, "https://example.test/registry/plan?count_record=50", "Компьютер", {
      debugDir: tempDir(), maxPages: 0, pageLoadTimeoutMs: 1000, delayMs: 0, allowedStatusNames: []
    });
    expect(items).toHaveLength(2501);
    expect(items.at(-1)?.plan_point_id).toBe("2501");
    expect(urls).toHaveLength(51);
    expect(new URL(urls.at(-1)!).searchParams.get("page")).toBe("51");
  });

  it("fails visibly when an explicit page budget would truncate the result", async () => {
    const { page } = searchPage(101);
    await expect(collectPlanSearch(page, "https://example.test/registry/plan?count_record=50", "Компьютер", {
      debugDir: tempDir(), maxPages: 2, pageLoadTimeoutMs: 1000, delayMs: 0, allowedStatusNames: []
    })).rejects.toThrow(/incomplete.*maxPages=2/i);
  });

  it("rejects a missing middle page instead of returning the collected prefix", async () => {
    const { page } = searchPage(101, { emptyPage: 2 });
    await expect(collectPlanSearch(page, "https://example.test/registry/plan?count_record=50", "Компьютер", {
      debugDir: tempDir(), maxPages: 0, pageLoadTimeoutMs: 1000, delayMs: 0, allowedStatusNames: []
    })).rejects.toThrow(/incomplete.*page=2/i);
  });

  it("does not request a phantom page after the last page link", async () => {
    const { page, urls } = searchPage(51);
    const items = await collectPlanSearch(page, "https://example.test/registry/plan?count_record=50", "Компьютер", {
      debugDir: tempDir(), maxPages: 0, pageLoadTimeoutMs: 1000, delayMs: 0, allowedStatusNames: []
    });
    expect(items).toHaveLength(51);
    expect(urls).toHaveLength(2);
  });

  it("uses one-based page links when the total count is not displayed", async () => {
    const { page, urls } = searchPage(51, { includeCount: false });
    const items = await collectPlanSearch(page, "https://example.test/registry/plan?count_record=50", "Компьютер", {
      debugDir: tempDir(), maxPages: 0, pageLoadTimeoutMs: 1000, delayMs: 0, allowedStatusNames: []
    });
    expect(items).toHaveLength(51);
    expect(urls).toHaveLength(2);
  });

  it("requests the same page size that is used to calculate the page count", async () => {
    const { page, urls } = searchPage(41, { recordsPerPage: 20 });
    const items = await collectPlanSearch(page, "https://example.test/registry/plan?count_record=20", "Компьютер", {
      debugDir: tempDir(), maxPages: 0, pageLoadTimeoutMs: 1000, delayMs: 0, allowedStatusNames: []
    });
    expect(items).toHaveLength(41);
    expect(urls).toHaveLength(3);
    expect(urls.every(url => new URL(url).searchParams.getAll("count_record").every(value => value === "20"))).toBe(true);
  });
});

describe("GZ plan page limit configuration", () => {
  it("defaults to all pages and enables it in both automated configurations", () => {
    const file = path.join(tempDir(), "plans.json");
    fs.writeFileSync(file, JSON.stringify({ keywords: ["Компьютер"] }));
    expect(loadGzPlansConfig(file).maxPages).toBe(0);
    for (const config of ["config/gz-plans.json", "config/gz-plans.pk.json", "config/gz-plans.example.json"]) {
      expect(loadGzPlansConfig(config).maxPages).toBe(0);
    }
  });

  it("accepts zero from the environment and validates an invalid override", () => {
    const config = loadGzPlansConfig("config/gz-plans.pk.json");
    vi.stubEnv("GOSZAKUP_PLAN_MAX_PAGES", "0");
    expect(mergeGzPlansExportOptions(config).maxPages).toBe(0);
    vi.stubEnv("GOSZAKUP_PLAN_MAX_PAGES", "invalid");
    expect(() => mergeGzPlansExportOptions(config)).toThrow();
  });
});
