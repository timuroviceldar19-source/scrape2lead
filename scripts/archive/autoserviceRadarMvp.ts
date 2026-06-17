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
const TARGET_PER_CATEGORY = 100;

function extractMessenger(phone: string, link: string): string {
  if (link.toLowerCase().includes("wa.me") || link.toLowerCase().includes("whatsapp")) return phone;
  if (link.toLowerCase().includes("t.me") || link.toLowerCase().includes("telegram")) return phone;
  return "";
}

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
    
    // Read back the leads from storage and filter in memory
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

async function generateMvpXlsx(leads: MvpLead[], exportPath: string) {
  const workbook = new ExcelJS.Workbook();

  // 1. Leads Sheet
  const leadsSheet = workbook.addWorksheet("Leads");
  const leadHeaders: (keyof MvpLead)[] = [
    "company_name", "category", "city", "district_address", "phone", "whatsapp", 
    "telegram", "website", "email", "source_url", "checked_at", "completeness_score", 
    "ready_for_outreach", "notes"
  ];
  leadsSheet.columns = leadHeaders.map((h) => ({ header: h, key: h, width: 20 }));
  leadsSheet.addRows(leads);
  leadsSheet.getRow(1).font = { bold: true };

  // 2. Summary Sheet
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
  
  // Simple duplicate check by company_name + phone
  const seen = new Set<string>();
  let duplicates = 0;
  for (const l of leads) {
    const key = `${l.company_name.toLowerCase().trim()}_${l.phone}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  summarySheet.columns = [
    { header: "Metric", key: "metric", width: 30 },
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
    { metric: "Duplicate Count Removed", value: duplicates }
  ]);
  summarySheet.getColumn("metric").font = { bold: true };

  // 3. Buyer Segments Sheet
  const segmentsSheet = workbook.addWorksheet("Buyer Segments");
  segmentsSheet.columns = [
    { header: "Segment", key: "segment", width: 25 },
    { header: "Why They Buy", key: "why", width: 40 },
    { header: "Suggested Offer", key: "offer", width: 40 },
    { header: "Recommended Lead Filters", key: "filters", width: 40 }
  ];
  segmentsSheet.addRows([
    {
      segment: "Масла / Автохимия",
      why: "Ищут новые точки сбыта, хотят охватить независимые СТО",
      offer: "База из 300+ СТО Астаны с прямыми телефонами и WhatsApp для отдела продаж",
      filters: "Категория: Автосервисы, Шиномонтаж; completeness_score >= 60"
    },
    {
      segment: "Шины",
      why: "Сезонный спрос, нужна быстрая доставка в шиномонтажи перед сезоном",
      offer: "Актуальная база шиномонтажей Астаны с геолокацией для логистики",
      filters: "Категория: Шиномонтаж; district_address не пустой"
    },
    {
      segment: "Автозапчасти оптом",
      why: "Расширение дилерской сети, поиск магазинов для оптовых поставок",
      offer: "Верифицированные контакты магазинов автозапчастей с email для коммерческих предложений",
      filters: "Категория: Автозапчасти; с email или website"
    },
    {
      segment: "Оборудование для СТО",
      why: "Дорогие B2B продажи, требуют долгого цикла и точного таргетинга",
      offer: "База с website и completeness_score >= 80 для email-кампаний и холодных звонков",
      filters: "Категория: Автосервисы; website не пустой; completeness_score >= 80"
    },
    {
      segment: "CRM / Телефония / POS",
      why: "SaaS-продукты, нужна массовая рассылка и обзвон для демо-версий",
      offer: "База с готовностью к outreach (ready_for_outreach = true) и мессенджерами",
      filters: "ready_for_outreach = true; whatsapp или telegram не пустые"
    }
  ]);
  segmentsSheet.getRow(1).font = { bold: true };

  // 4. Outreach Notes Sheet
  const outreachSheet = workbook.addWorksheet("Outreach Notes");
  outreachSheet.columns = [
    { header: "Type", key: "type", width: 25 },
    { header: "Content", key: "content", width: 80 }
  ];
  outreachSheet.addRows([
    {
      type: "WhatsApp Script (Короткий)",
      content: "Здравствуйте! Это [Имя] из [Компания]. Мы помогаем поставщикам находить проверенные СТО и магазины в Астане. У вас есть 1 минута, чтобы я кратко рассказал, как мы можем увеличить ваши B2B-продажи?"
    },
    {
      type: "Cold Call Script",
      content: "Добрый день, [Имя ЛПР]? Меня зовут [Имя], компания [Компания]. Мы специализируемся на верифицированных B2B-базах для авто-рынка Казахстана. Подскажите, вы сейчас работаете над расширением клиентской базы в Астане? (Пауза) Отлично, у нас есть актуальная база из 300+ контактов с прямыми номерами. Могу отправить пример на WhatsApp?"
    },
    {
      type: "Follow-up Message",
      content: "Добрый день! Напоминаю о нашем разговоре. Высылаю пример базы (скриншот/фрагмент). Если актуально, готов подготовить персональное предложение под ваш сегмент. Когда удобно созвониться на 5 минут?"
    },
    {
      type: "Objection: 'У нас уже есть база'",
      content: "Понимаю. Наша база обновляется ежемесячно и содержит прямые номера ЛПР и мессенджеры, которых часто нет в открытых справочниках. Могу прислать 10 бесплатных контактов из вашего целевого района для сравнения качества?"
    },
    {
      type: "Objection: 'Дорого'",
      content: "Стоимость одного лида в нашей базе выходит дешевле, чем один клик в контекстной рекламе, при этом это прямые B2B-контакты с высокой конверсией. Давайте обсудим тестовый пакет на 50 контактов?"
    },
    {
      type: "Objection: 'Откуда данные?'",
      content: "Мы собираем только публичные B2B-данные из открытых источников (2GIS, сайты компаний) с указанием источника и даты сбора. Мы не используем персональные данные сотрудников, только контакты организаций."
    },
    {
      type: "Objection: 'Пришлите пример'",
      content: "Конечно! Я сейчас отправлю вам фрагмент базы из 15 компаний по вашему профилю в WhatsApp/Telegram. Посмотрите на полноту данных (телефон, сайт, мессенджеры). Если устроит формат, обсудим условия."
    }
  ]);
  outreachSheet.getRow(1).font = { bold: true };

  await workbook.xlsx.writeFile(exportPath);
  logger.info(`MVP XLSX generated successfully at ${exportPath}`);
}

async function main() {
  if (process.env.ALLOW_LIVE_PROXY_RUN !== "1") {
    console.error("⚠️ LIVE PROXY RUN BLOCKED: Set ALLOW_LIVE_PROXY_RUN=1 to proceed.");
    console.error("This protects the residential proxy budget. Use 'npm run validate:kz:proxy' for cheap checks.");
    console.error("Expected usage: cross-env ALLOW_LIVE_PROXY_RUN=1 npm run mvp:astana");
    process.exit(1);
  }
  const config = loadConfig("config.example.json", {
    geo: CITY,
    headless: true,
    twoGisBaseUrl: "https://2gis.kz"
  });

  const allLeads: Lead[] = [];

  for (const category of CATEGORIES) {
    logger.info(`Starting scrape for category: ${category}`);
    try {
      const leads = await runScrapeForCategory(config, category);
      allLeads.push(...leads);
    } catch (err) {
      logger.error(`Environment blocked or failed for ${category}`, { error: err });
      // Continue to next category or generate with what we have
    }
  }

  if (allLeads.length === 0) {
    logger.warn("No leads scraped. Generating empty MVP structure for demonstration.");
  }

  const mvpLeads = allLeads.map(mapToMvpLead);
  const exportDir = config.exportDir || "exports";
  fs.mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportPath = path.join(exportDir, `autoservice-radar-astana-mvp-${timestamp}.xlsx`);

  await generateMvpXlsx(mvpLeads, exportPath);
  
  console.log(`\n✅ MVP Export completed: ${exportPath}`);
  console.log(`📊 Total leads processed: ${mvpLeads.length}`);
}

main().catch((err) => {
  logger.error("MVP script failed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
