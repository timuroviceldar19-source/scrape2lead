import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";

const DB_PATH = "data/scrape2lead-kz.db";
const EXPORT_PATH = path.join("exports", "B2B-AutoService-SalesPack-READY.xlsx");

interface Lead {
  company_name: string;
  category: string;
  city: string;
  address: string;
  phones: string;
  email: string | null;
  website: string | null;
  messenger_links: string;
  parsed_at: string;
}

function parseJsonArray(jsonStr: string): string[] {
  try {
    return JSON.parse(jsonStr);
  } catch {
    return [];
  }
}

function calculateCompleteness(lead: Lead): number {
  let score = 0;
  const phones = parseJsonArray(lead.phones);
  if (phones.length > 0) score += 40;
  if (lead.email) score += 20;
  if (lead.website) score += 20;
  if (lead.address && lead.address.trim() !== "") score += 20;
  return score;
}

function main() {
  console.log("🚀 Генерация коммерческого пакета B2B...");
  
  const db = new Database(DB_PATH);
  const rows = db.prepare(`
    SELECT company_name, category, city, address, phones, email, website, messenger_links, parsed_at 
    FROM leads 
    ORDER BY parsed_at DESC 
    LIMIT 50
  `).all() as Lead[];
  db.close();

  if (rows.length === 0) {
    console.error("❌ В базе нет данных для экспорта.");
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();

  // ==========================================
  // Вкладка 1: Горячие лиды
  // ==========================================
  const leadsSheet = workbook.addWorksheet("Горячие лиды");
  leadsSheet.columns = [
    { header: "Компания", key: "company", width: 30 },
    { header: "Город", key: "city", width: 15 },
    { header: "Адрес", key: "address", width: 35 },
    { header: "Телефон", key: "phone", width: 20 },
    { header: "WhatsApp / TG", key: "messenger", width: 20 },
    { header: "Сайт", key: "website", width: 30 },
    { header: "Email", key: "email", width: 25 },
    { header: "Полнота (%)", key: "score", width: 12 },
    { header: "Готов к рассылке", key: "ready", width: 18 }
  ];

  const formattedLeads = rows.map((lead) => {
    const phones = parseJsonArray(lead.phones);
    const mainPhone = phones[0] || "Нет";
    const messengers = parseJsonArray(lead.messenger_links);
    const hasWA = messengers.some((m: string) => m.toLowerCase().includes("wa.me") || m.toLowerCase().includes("whatsapp"));
    const hasTG = messengers.some((m: string) => m.toLowerCase().includes("t.me") || m.toLowerCase().includes("telegram"));
    const messengerStr = hasWA ? "WhatsApp" : hasTG ? "Telegram" : "Нет";
    
    const score = calculateCompleteness(lead);
    const ready = score >= 60 && mainPhone !== "Нет";

    return {
      company: lead.company_name,
      city: lead.city,
      address: lead.address,
      phone: mainPhone,
      messenger: messengerStr,
      website: lead.website || "Нет",
      email: lead.email || "Нет",
      score: `${score}%`,
      ready: ready ? "✅ Да" : "⚠️ Проверить"
    };
  });

  leadsSheet.addRows(formattedLeads);
  leadsSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  leadsSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5597" } };

  // ==========================================
  // Вкладка 2: Кому продавать (Сегменты)
  // ==========================================
  const segmentsSheet = workbook.addWorksheet("Кому продавать");
  segmentsSheet.columns = [
    { header: "Целевой клиент", key: "client", width: 25 },
    { header: "Какую боль решает база", key: "pain", width: 45 },
    { header: "Что предлагаем", key: "offer", width: 45 },
    { header: "Фильтр в Excel", key: "filter", width: 30 }
  ];
  segmentsSheet.addRows([
    {
      client: "Поставщики масел и автохимии",
      pain: "Ищут новые точки сбыта, хотят охватить независимые СТО, а не только дилеров",
      offer: "База из 50+ проверенных СТО с прямыми мобильными номерами для отдела продаж",
      filter: "Готов к рассылке = ✅ Да"
    },
    {
      client: "Оптовые продавцы шин",
      pain: "Сезонный спрос, нужна быстрая доставка в шиномонтажи перед сезоном",
      offer: "Актуальная база с геолокацией и WhatsApp для быстрой логистики",
      filter: "WhatsApp = WhatsApp"
    },
    {
      client: "Внедренцы CRM / Телефонии",
      pain: "Нужна массовая рассылка и обзвон для продажи демо-версий SaaS",
      offer: "База с готовностью к outreach и наличием мессенджеров",
      filter: "Готов к рассылке = ✅ Да"
    },
    {
      client: "Веб-студии и SEO-агентства",
      pain: "Ищут компании с сайтом, но без современной аналитики или мессенджеров",
      offer: "Список автосервисов, у которых есть сайт, но нет WhatsApp/Telegram",
      filter: "Сайт != 'Нет' И WhatsApp / TG = 'Нет'"
    }
  ]);
  segmentsSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  segmentsSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5597" } };

  // ==========================================
  // Вкладка 3: Скрипты продаж
  // ==========================================
  const scriptsSheet = workbook.addWorksheet("Скрипты продаж");
  scriptsSheet.columns = [
    { header: "Тип контакта", key: "type", width: 25 },
    { header: "Текст сообщения / Скрипт", key: "text", width: 90 }
  ];
  scriptsSheet.addRows([
    {
      type: "WhatsApp (Первое касание)",
      text: "Здравствуйте! Это [Ваше Имя]. Мы помогаем поставщикам находить проверенные СТО и автосервисы в Алматы/Астане. \n\nУ нас есть актуальная база с прямыми телефонами, WhatsApp и сайтами (дубли удалены, дата проверки указана). \n\nЕсли вы продаете масла, шины, запчасти или оборудование для СТО — могу бесплатно отправить 15-20 строк для оценки качества. Актуально для вашего отдела продаж?"
    },
    {
      type: "Холодный звонок (ЛПР)",
      text: "Добрый день, [Имя, если известно, или 'подскажите, кто отвечает за развитие клиентской базы']? \nМеня зовут [Ваше Имя], мы специализируемся на верифицированных B2B-базах для авто-рынка Казахстана. \nПодскажите, вы сейчас работаете над расширением числа активных клиентов в Алматы? \n*(Пауза, слушаем ответ)* \nОтлично. У нас есть свежая база проверенных автосервисов с прямыми номерами и мессенджерами. Могу я отправить вам короткий sample на WhatsApp прямо сейчас, чтобы вы оценили полноту данных?"
    },
    {
      type: "Отработка возражения: 'У нас уже есть база'",
      text: "Понимаю. Наша база обновляется ежемесячно и содержит прямые мобильные номера и мессенджеры, которых часто нет в открытых справочниках. Могу прислать 10 бесплатных контактов из вашего целевого района для сравнения качества?"
    },
    {
      type: "Отработка возражения: 'Дорого'",
      text: "Стоимость одного лида в нашей базе выходит дешевле, чем один клик в контекстной рекламе, при этом это прямые B2B-контакты с высокой конверсией. Давайте обсудим тестовый пакет на 50 контактов?"
    },
    {
      type: "Follow-up (через 2 дня)",
      text: "Добрый день! Напоминаю о нашем разговоре по базе автосервисов. Высылаю пример (фрагмент Excel). Если актуально, готов подготовить персональное предложение под ваш сегмент. Когда удобно созвониться на 5 минут?"
    }
  ]);
  scriptsSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  scriptsSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5597" } };
  scriptsSheet.getColumn("text").alignment = { wrapText: true };

  // ==========================================
  // Сохранение
  // ==========================================
  fs.mkdirSync("exports", { recursive: true });
  workbook.xlsx.writeFile(EXPORT_PATH).then(() => {
    console.log(`✅ Коммерческий пакет успешно создан!`);
    console.log(`📁 Путь к файлу: ${path.resolve(EXPORT_PATH)}`);
    console.log(`📊 Всего лидов в пакете: ${formattedLeads.length}`);
    const readyCount = formattedLeads.filter(l => l.ready === "✅ Да").length;
    console.log(`🔥 Из них полностью готовых к рассылке: ${readyCount}`);
  }).catch((err) => {
    console.error("❌ Ошибка при сохранении файла:", err);
  });
}

main();