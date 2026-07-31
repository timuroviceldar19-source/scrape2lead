import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { parseContractGeneralHtml, parseContractSearchHtml, parseContractUnitNamesHtml } from "../src/kz/goszakupContractParser.js";
import { buildLeadCodeProposal, renderLeadCodeProposal } from "../src/kz/goszakupLeadCodeProposal.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run kz:propose-lead-codes\nReads the public contract registry for the last three months and prints a review-only code table.");
  process.exit(0);
}

const now = new Date();
const to = iso(now);
const from = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate())));
const base = "https://www.goszakup.gov.kz";
const maxCards = 2_000;
const pageDelayMs = 1_750;
const cacheDir = path.join("data", "gz-lead-code-proposal", `${from}-${to}`);
fs.mkdirSync(path.join(cacheDir, "contracts"), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "ru-RU" });
  const rows: Array<{ code: string; name: string; contracts: number }> = [];
  const dates: string[] = [];
  const first = parseContractSearchHtml(await loadPage(page, contractUrl(1), path.join(cacheDir, "registry-page-1.html")), 50);
  const totalPages = first.pagination.totalPages;
  const pageCount = Math.min(totalPages, Math.ceil(maxCards / 50));
  for (let pageNo = totalPages; pageNo > totalPages - pageCount; pageNo--) {
    const search = pageNo === 1 ? first : parseContractSearchHtml(await loadPage(page, contractUrl(pageNo), path.join(cacheDir, `registry-page-${pageNo}.html`)), 50);
    console.log(`contracts page=${pageNo}/${totalPages}`);
    for (const contract of search.items) {
      if (dates.length >= maxCards) break;
      const general = await loadPage(page, `${base}/ru/egzcontract/cpublic/show/${contract.contractId}`, path.join(cacheDir, "contracts", `${contract.contractId}-general.html`));
      const signedAt = parseContractGeneralHtml(general).signedAt?.slice(0, 10);
      if (!signedAt) continue;
      dates.push(signedAt);
      const units = await loadPage(page, `${base}/ru/egzcontract/cpublic/units/${contract.contractId}`, path.join(cacheDir, "contracts", `${contract.contractId}-units.html`));
      for (const unit of parseContractUnitNamesHtml(units)) rows.push({ ...unit, contracts: 1 });
    }
    if (pageNo > totalPages - pageCount + 1) await sleep(pageDelayMs);
  }
  const stats = { rows: dates.length, minDate: [...dates].sort()[0] ?? null, maxDate: [...dates].sort().at(-1) ?? null };
  console.log(`sample cards=${stats.rows} min=${stats.minDate ?? "-"} max=${stats.maxDate ?? "-"} cache=${cacheDir}`);
  console.log(renderLeadCodeProposal(buildLeadCodeProposal(rows), stats));
} finally { await browser.close(); }

function iso(date: Date): string { return date.toISOString().slice(0, 10); }
function contractUrl(pageNo: number): string { const params = new URLSearchParams({ "filter[start_date_from]": from, "filter[start_date_to]": to, count_record: "50" }); if (pageNo > 1) params.set("page", String(pageNo)); return `${base}/ru/registry/contract?${params}`; }
async function loadPage(page: import("playwright").Page, url: string, cachePath: string): Promise<string> { if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, "utf8"); await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }); const html = await page.content(); fs.writeFileSync(cachePath, html, "utf8"); return html; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
