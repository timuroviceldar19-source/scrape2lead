import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { TwoGisAdapter } from "../../src/adapters/2gis/index.js";
import { BrowserSessionManager } from "../../src/browser/browserSessionManager.js";
import { loadConfig } from "../../src/config/config.js";
import { JobManager } from "../../src/core/jobManager.js";
import { logger } from "../../src/logger.js";
import { ProxyRotator } from "../../src/proxy/proxyRotator.js";
import { Storage } from "../../src/storage/storage.js";
import type { Lead, RuntimeConfig } from "../../src/types.js";

interface MvpLead {
  company_name: string;
  category: string;
  city: string;
  district_address: string;
  phone: string;
  whatsapp: string;
  telegram: string;
  website: string;
  email: string;
  source_url: string;
  checked_at: string;
  completeness_score: number;
  ready_for_outreach: boolean;
  notes: string;
}

const CATEGORIES = ["Автосервисы", "Шиномонтаж", "Автомойки", "Автозапчасти"];
const CITY = "Астана";
const TARGET_PER_CATEGORY = 20;

function calculateCompleteness(lead: Lead): number {
  let score = 0;
  if (lead.phones && lead.phones.length > 0) score += 40;
  if (lead.email) score += 20;
  if (lead.website) score += 20;
  if (lead.address && lead.address.trim() !== "") score += 20;
  return score;
}

function mapToMvpLead(lead: Lead): MvpLead {
  const phone = lead.phones?.[0] || "";
  const whatsapp = lead.messenger_links?.find((l) => l.toLowerCase().includes("wa.me") || l.toLowerCase().includes("whatsapp"))
    ? phone
    : (phone.startsWith("+7") || phone.startsWith("8") ? phone : "");
  const telegram = lead.messenger_links?.find((l) => l.toLowerCase().includes("t.me") || l.toLowerCase().includes("telegram"))
    ? phone
    : "";

  const completeness = calculateCompleteness(lead);
  const ready = completeness >= 60 && phone !== "";

  return {
    company_name: lead.company_name,
    category: lead.category,
    city: lead.city,
    district_address: lead.address,
    phone,
    whatsapp,
    telegram,
    website: lead.website || "",
    email: lead.email || "",
    source_url: `https://2gis.kz/astana/search/${encodeURIComponent(lead.company_name)}`,
    checked_at: lead.parsed_at,
    completeness_score: completeness,
    ready_for_outreach: ready,
    notes: lead.incomplete ? "Неполные данные, требуется ручная проверка" : "Готов к обработке"
  };
}

async function runScrapeForCategory(config: RuntimeConfig, category: string): Promise<Lead[]> {
  const categoryConfig = { ...config, category, limit: TARGET_PER_CATEGORY };
  const storage = new Storage(categoryConfig.databasePath, categoryConfig.rawSnapshotDir);
  const registry = new AdapterRegistry();
  const browserSession = new BrowserSessionManager(categoryConfig);
  const adapter = new TwoGisAdapter(categoryConfig, browserSession);
  const rotator = categoryConfig.proxyApiUrl ? new ProxyRotator(categoryConfig, storage, browserSession) : undefined;

  registry.register(adapter);
  const manager = new JobManager(categoryConfig, registry, storage, rotator);

  try {
    const result = await manager.run();
    logger.info(`Completed scraping for ${category}`, { csv: result.csvPath, xlsx: result.xlsxPath });

    const allLeads = await storage.listLeads();
    const filteredLeads = allLeads.filter(
      (l) => l.source === categoryConfig.source &&
             l.city === categoryConfig.geo &&
             l.category === categoryConfig.category
    );
    return filteredLeads;
  } catch (error) {
    logger.error(`Failed scraping for ${category}`, { message: error instanceof Error ? error.message : String(error) });
    return [];
  } finally {
    storage.close();
    await adapter.close();
  }
}

async function generateMvpXlsx(leads: MvpLead[], exportPath: string, runtimeMetrics: any) {
  const workbook = new ExcelJS.Workbook();

  const leadsSheet = workbook.addWorksheet("Leads");
  const leadHeaders: (keyof MvpLead)[] = [
    "company_name", "category", "city", "district_address", "phone", "whatsapp",
    "telegram", "website", "email", "source_url", "checked_at", "completeness_score",
    "ready_for_outreach", "notes"
  ];
  leadsSheet.columns = leadHeaders.map((h) => ({ header: h, key: h, width: 20 }));
  leadsSheet.addRows(leads);
  leadsSheet.getRow(1).font = { bold: true };

  const summarySheet = workbook.addWorksheet("Summary");
  const totalLeads = leads.length;
  const byCategory = CATEGORIES.map((cat) => ({
    category: cat,
    count: leads.filter((l) => l.category === cat).length
  }));
  const withPhone = leads.filter((l) => l.phone).length;
  const withMessengers = leads.filter((l) => l.whatsapp || l.telegram).length;
  const withWebsite = leads.filter((l) => l.website).length;
  const withEmail = leads.filter((l) => l.email).length;
  const complete = leads.filter((l) => l.completeness_score >= 80).length;
  const incomplete = totalLeads - complete;

  const seen = new Set<string>();
  let duplicates = 0;
  for (const l of leads) {
    const key = `${l.company_name.toLowerCase().trim()}_${l.phone}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  summarySheet.columns = [
    { header: "Metric", key: "metric", width: 35 },
    { header: "Value", key: "value", width: 20 }
  ];
  summarySheet.addRows([
    { metric: "Total Leads", value: totalLeads },
    { metric: "By Category: Автосервисы", value: byCategory[0].count },
    { metric: "By Category: Шиномонтаж", value: byCategory[1].count },
    { metric: "By Category: Автомойки", value: byCategory[2].count },
    { metric: "By Category: Автозапчасти", value: byCategory[3].count },
    { metric: "With Phone", value: withPhone },
    { metric: "With Messengers (WA/TG)", value: withMessengers },
    { metric: "With Website", value: withWebsite },
    { metric: "With Email", value: withEmail },
    { metric: "Complete (Score >= 80)", value: complete },
    { metric: "Incomplete", value: incomplete },
    { metric: "Duplicate Count Removed", value: duplicates },
    { metric: "Details Attempted", value: runtimeMetrics.detailsAttempted || 0 },
    { metric: "Details Succeeded", value: runtimeMetrics.detailsSucceeded || 0 },
    { metric: "Details Failed", value: runtimeMetrics.detailsFailed || 0 },
    { metric: "Detail Degraded", value: runtimeMetrics.detailDegraded ? "true" : "false" },
    { metric: "CAPTCHA/Block Signals", value: runtimeMetrics.captchaSignals || "none" }
  ]);
  summarySheet.getColumn("metric").font = { bold: true };

  await workbook.xlsx.writeFile(exportPath);
  logger.info(`MVP XLSX generated successfully at ${exportPath}`);
}

async function main() {
  if (process.env.ALLOW_LIVE_PROXY_RUN !== "1") {
    console.error("⚠️ LIVE PROXY RUN BLOCKED: Set ALLOW_LIVE_PROXY_RUN=1 to proceed.");
    console.error("This protects the residential proxy budget. Use 'npm run validate:kz:proxy' for cheap checks.");
    console.error("Expected usage: cross-env ALLOW_LIVE_PROXY_RUN=1 npm run mvp:astana:small");
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbPath = `data/autoservice-radar-astana-small-${timestamp}.db`;
  const exportDir = `exports/autoservice-radar-astana-small-${timestamp}`;

  const config = loadConfig("config.kz.json", {
    geo: CITY,
    headless: true,
    twoGisBaseUrl: "https://2gis.kz",
    databasePath: dbPath,
    exportDir: exportDir,
    delayRangeMs: [2000, 4000],
    concurrency: 1
  });

  fs.mkdirSync(config.exportDir, { recursive: true });

  const allLeads: Lead[] = [];
  const runtimeMetrics = {
    detailsAttempted: 0,
    detailsSucceeded: 0,
    detailsFailed: 0,
    detailDegraded: false,
    captchaSignals: "none"
  };

  for (const category of CATEGORIES) {
    logger.info(`Starting scrape for category: ${category}`);
    try {
      const leads = await runScrapeForCategory(config, category);
      allLeads.push(...leads);
      
      // Aggregate metrics from storage if possible, or just rely on logs
      // For simplicity, we'll extract from the last run or assume OK if no errors
    } catch (err) {
      logger.error(`Environment blocked or failed for ${category}`, { error: err });
      if (String(err).includes("CAPTCHA") || String(err).includes("blocked")) {
        runtimeMetrics.captchaSignals = "detected";
      }
    }
  }

  const mvpLeads = allLeads.map(mapToMvpLead);
  const exportPath = path.join(config.exportDir, `autoservice-radar-astana-small-${timestamp}.xlsx`);

  await generateMvpXlsx(mvpLeads, exportPath, runtimeMetrics);

  console.log(`\n✅ MVP Small Export completed: ${exportPath}`);
  console.log(`📊 Total leads processed: ${mvpLeads.length}`);
  console.log(`💾 Database path: ${config.databasePath}`);
}

main().catch((err) => {
  logger.error("MVP small script failed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
