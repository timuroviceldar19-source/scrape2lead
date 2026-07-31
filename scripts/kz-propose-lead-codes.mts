import { chromium } from "playwright";
import { parseContractGeneralHtml, parseContractSearchHtml, parseContractUnitNamesHtml } from "../src/kz/goszakupContractParser.js";
import { buildLeadCodeProposal, renderLeadCodeProposal, validateContractSourceCoverage } from "../src/kz/goszakupLeadCodeProposal.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run kz:propose-lead-codes\nReads the public contract registry for the last three months and prints a review-only code table.");
  process.exit(0);
}

const now = new Date();
const to = iso(now);
const from = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate())));
const base = "https://www.goszakup.gov.kz";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "ru-RU" });
  const rows: Array<{ code: string; name: string; contracts: number }> = [];
  const dates: string[] = [];
  let totalPages = 1;
  for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
    const params = new URLSearchParams({ "filter[start_date_from]": from, "filter[start_date_to]": to, count_record: "50" });
    if (pageNo > 1) params.set("page", String(pageNo));
    await page.goto(`${base}/ru/registry/contract?${params}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const search = parseContractSearchHtml(await page.content(), 50);
    totalPages = search.pagination.totalPages;
    console.log(`contracts page=${pageNo}/${totalPages}`);
    for (const contract of search.items) {
      await page.goto(`${base}/ru/egzcontract/cpublic/show/${contract.contractId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const signedAt = parseContractGeneralHtml(await page.content()).signedAt?.slice(0, 10);
      if (!signedAt) continue;
      dates.push(signedAt);
      await page.goto(`${base}/ru/egzcontract/cpublic/units/${contract.contractId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      for (const unit of parseContractUnitNamesHtml(await page.content())) rows.push({ ...unit, contracts: 1 });
    }
  }
  const stats = { rows: dates.length, minDate: [...dates].sort()[0] ?? null, maxDate: [...dates].sort().at(-1) ?? null };
  console.log(`source rows=${stats.rows} min=${stats.minDate ?? "-"} max=${stats.maxDate ?? "-"}`);
  validateContractSourceCoverage(stats, from, to);
  console.log(renderLeadCodeProposal(buildLeadCodeProposal(rows)));
} finally { await browser.close(); }

function iso(date: Date): string { return date.toISOString().slice(0, 10); }
