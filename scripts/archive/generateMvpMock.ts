import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { logger } from "../../src/logger.js";

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

function generateMockLeads(): MvpLead[] {
  const leads: MvpLead[] = [];
  const now = new Date().toISOString();
  
  for (let i = 1; i <= 120; i++) {
    const cat = CATEGORIES[i % 4];
    const hasPhone = i % 5 !== 0;
    const hasEmail = i % 3 === 0;
    const hasWebsite = i % 4 === 0;
    const hasWa = hasPhone && i % 2 === 0;
    const hasTg = hasPhone && i % 3 === 0;
    
    let score = 20; // address
    if (hasPhone) score += 40;
    if (hasEmail) score += 20;
    if (hasWebsite) score += 20;

    leads.push({
      company_name: `Авто-Компания ${i}`,
      category: cat,
      city: "Астана",
      district_address: `ул. Примерная, д. ${i}`,
      phone: hasPhone ? `+7 (701) 123-45-${String(i).padStart(2, '0')}` : "",
      whatsapp: hasWa ? `+7 (701) 123-45-${String(i).padStart(2, '0')}` : "",
      telegram: hasTg ? `+7 (701) 123-45-${String(i).padStart(2, '0')}` : "",
      website: hasWebsite ? `https://example${i}.kz` : "",
      email: hasEmail ? `info@example${i}.kz` : "",
      source_url: `https://2gis.kz/astana/firm/${100000 + i}`,
      checked_at: now,
      completeness_score: score,
      ready_for_outreach: score >= 60 && hasPhone,
      notes: score >= 80 ? "Отличные данные" : "Требует проверки"
    });
  }
  return leads;
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
  const exportDir = "exports";
  fs.mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportPath = path.join(exportDir, `autoservice-radar-astana-mvp-${timestamp}.xlsx`);

  const mockLeads = generateMockLeads();
  await generateMvpXlsx(mockLeads, exportPath);
  
  console.log(`\n✅ MVP Export completed (Mock Data due to ENVIRONMENT_BLOCKED): ${exportPath}`);
  console.log(`📊 Total leads generated: ${mockLeads.length}`);
}

main().catch((err) => {
  logger.error("MVP mock script failed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
