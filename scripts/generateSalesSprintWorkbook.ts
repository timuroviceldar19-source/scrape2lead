import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const EXPORTS_DIR = "exports";
const REAL_SAMPLE_PATH = path.join(EXPORTS_DIR, "autoservice-radar-astana-real-sample-50.xlsx");
const WORKBOOK_PATH = path.join(EXPORTS_DIR, "autoservice-radar-sales-sprint-workbook.xlsx");

const REAL_SAMPLE_HEADERS = [
  "Компания", "Категория", "Город", "Адрес", "Телефон", "WhatsApp", "Telegram", 
  "Сайт", "Email", "Источник", "Дата проверки", "Полнота данных", "Готов к рассылке", 
  "Статус проверки", "Заметки"
];

const HEADER_MAPPING: Record<string, string> = {
  "company_name": "Компания",
  "company": "Компания",
  "название": "Компания",
  "category": "Категория",
  "категория": "Категория",
  "city": "Город",
  "город": "Город",
  "address": "Адрес",
  "district_address": "Адрес",
  "адрес": "Адрес",
  "phone": "Телефон",
  "телефон": "Телефон",
  "whatsapp": "WhatsApp",
  "telegram": "Telegram",
  "website": "Сайт",
  "сайт": "Сайт",
  "email": "Email",
  "почта": "Email",
  "source_url": "Источник",
  "source": "Источник",
  "источник": "Источник",
  "checked_at": "Дата проверки",
  "дата": "Дата проверки",
  "completeness_score": "Полнота данных",
  "полнота": "Полнота данных",
  "ready_for_outreach": "Готов к рассылке",
  "готов": "Готов к рассылке",
  "notes": "Заметки",
  "заметки": "Заметки",
  "статус проверки": "Статус проверки",
  "status": "Статус проверки"
};

async function main() {
  console.log("🚀 Generating Sales Sprint Workbook...");
  const workbook = new ExcelJS.Workbook();

  // 1. План
  const planSheet = workbook.addWorksheet("План");
  planSheet.columns = [
    { header: "Параметр", key: "param", width: 40 }, 
    { header: "Значение", key: "value", width: 80 }
  ];
  planSheet.addRows([
    { param: "Продукт", value: "AutoService Radar KZ" },
    { param: "Цель", value: "Первый sales sprint" },
    { param: "Проверенных строк", value: 15 },
    { param: "Осталось добрать", value: 35 },
    { param: "Целевая готовность", value: "Минимум 45/50 строк с полнотой >= 80" },
    { param: "⚠️ ЗАПРЕТ", value: "Не запускать live scraping через текущий proxy без отдельного решения" }
  ]);
  planSheet.getRow(6).font = { color: { argb: "FFFF0000" }, bold: true };

  // 2. Real Sample 50
  const realSampleSheet = workbook.addWorksheet("Real Sample 50");
  realSampleSheet.columns = REAL_SAMPLE_HEADERS.map(h => ({ 
    header: h, 
    key: h.toLowerCase().replace(/\s+/g, '_'), 
    width: 20 
  }));
  
  let existingRowsCount = 0;
  if (fs.existsSync(REAL_SAMPLE_PATH)) {
    const existingWorkbook = new ExcelJS.Workbook();
    await existingWorkbook.xlsx.readFile(REAL_SAMPLE_PATH);
    const sourceSheet = existingWorkbook.worksheets[0];
    if (sourceSheet) {
      const sourceHeaders: string[] = [];
      sourceSheet.getRow(1).eachCell((cell, colNumber) => {
        sourceHeaders[colNumber] = String(cell.value || "").trim().toLowerCase();
      });

      sourceSheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          const newRow: any = {};
          REAL_SAMPLE_HEADERS.forEach((targetHeader) => {
            const targetKey = targetHeader.toLowerCase().replace(/\s+/g, '_');
            // Find matching source column
            const sourceColIndex = sourceHeaders.findIndex(h => {
              if (!h) return false;
              const mappedTarget = Object.entries(HEADER_MAPPING).find(([_, v]) => v === targetHeader)?.[0] || targetHeader;
              return h.includes(mappedTarget.toLowerCase().split(' ')[0]);
            });
            
            if (sourceColIndex !== -1) {
              newRow[targetKey] = row.getCell(sourceColIndex).value;
            }
          });
          realSampleSheet.addRow(newRow);
          existingRowsCount++;
        }
      });
    }
  }

  // Add empty rows up to 50
  const remainingRows = Math.max(0, 50 - existingRowsCount);
  for (let i = 0; i < remainingRows; i++) {
    realSampleSheet.addRow({});
  }

  // 3. Что добрать
  const toGatherSheet = workbook.addWorksheet("Что добрать");
  const toGatherHeaders = ["Компания", "Категория", "Телефон", "WhatsApp", "Адрес", "Источник", "Дата проверки", "Статус проверки"];
  toGatherSheet.columns = toGatherHeaders.map(h => ({ 
    header: h, 
    key: h.toLowerCase().replace(/\s+/g, '_'), 
    width: 20 
  }));
  
  const categoriesToGather = [
    ...Array(10).fill("Шиномонтаж"),
    ...Array(10).fill("Автомойка"),
    ...Array(10).fill("Магазин автозапчастей"),
    ...Array(5).fill("Автосервис")
  ];
  
  categoriesToGather.forEach(cat => {
    toGatherSheet.addRow({ категория: cat });
  });

  // 4. Покупатели
  const buyersSheet = workbook.addWorksheet("Покупатели");
  const buyersHeaders = ["Компания", "Сегмент", "Контакт", "Канал", "Дата отправки", "Статус ответа", "Следующее действие", "Заметки"];
  buyersSheet.columns = buyersHeaders.map(h => ({ 
    header: h, 
    key: h.toLowerCase().replace(/\s+/g, '_'), 
    width: 20 
  }));
  
  for (let i = 0; i < 50; i++) {
    buyersSheet.addRow({});
  }

  // Data validations for Покупатели
  const segmentValidation = {
    type: 'list' as const,
    allowBlank: true,
    formulae: ['"Поставщики масел,Поставщики шин,Оптовики автозапчастей,Автохимия,Оборудование для СТО,CRM / телефония / POS"']
  };
  buyersSheet.dataValidations.add('B2:B51', segmentValidation);

  const channelValidation = {
    type: 'list' as const,
    allowBlank: true,
    formulae: ['"WhatsApp,Звонок,Email,Instagram,Telegram,Сайт / форма"']
  };
  buyersSheet.dataValidations.add('D2:D51', channelValidation);

  const statusValidation = {
    type: 'list' as const,
    allowBlank: true,
    formulae: ['"Отправлено,Нет ответа,Ответил, есть интерес,Попросил 50 строк,Обсуждаем пилот,Оплатил,Не актуально,Нужен другой контакт,Связаться позже,Отправлен повторный контакт"']
  };
  buyersSheet.dataValidations.add('F2:F51', statusValidation);

  // 5. Статусы
  const statusesSheet = workbook.addWorksheet("Статусы");
  statusesSheet.columns = [
    { header: "Статус", key: "status", width: 30 },
    { header: "Описание", key: "description", width: 80 }
  ];
  statusesSheet.addRows([
    { status: "Отправлено", description: "Сообщение или звонок сделан, ждем реакцию." },
    { status: "Нет ответа", description: "Прошло 3+ дня, требуется follow-up." },
    { status: "Ответил, есть интерес", description: "Клиент заинтересован, готов обсудить детали." },
    { status: "Попросил 50 строк", description: "Клиент запросил тестовый sample (высокий шанс конверсии)." },
    { status: "Обсуждаем пилот", description: "Согласовываем объем, цену и сроки тестового периода." },
    { status: "Оплатил", description: "Сделка закрыта, переходим к передаче данных." },
    { status: "Не актуально", description: "Четкий отказ. Переносим в архив." },
    { status: "Нужен другой контакт", description: "Текущий собеседник не является ЛПР." },
    { status: "Связаться позже", description: "Интерес есть, но сейчас не сезон или нет бюджета." },
    { status: "Отправлен повторный контакт", description: "Follow-up сообщение или второй звонок отправлен." }
  ]);

  // 6. Сообщения
  const messagesSheet = workbook.addWorksheet("Сообщения");
  messagesSheet.columns = [
    { header: "Тип сообщения", key: "type", width: 25 },
    { header: "Текст", key: "text", width: 100 }
  ];
  messagesSheet.addRows([
    { 
      type: "Первое WhatsApp-сообщение", 
      text: "Здравствуйте. У нас есть проверенная B2B-база автосервисов по Астане: СТО, шиномонтажи, автомойки.\n\nЕсть телефоны, WhatsApp, адреса, сайты/email где доступны, дубли убраны, стоит дата проверки.\n\nЕсли вы продаёте масла, шины, запчасти, автохимию или оборудование для СТО — можем отправить 50 строк для оценки качества бесплатно.\n\nАктуально для вашего отдела продаж?" 
    },
    { 
      type: "Follow-up через 1-2 дня", 
      text: "Здравствуйте. Возвращаюсь по базе автосервисов Астаны.\n\nМожем бесплатно отправить 50 строк: СТО/шиномонтажи/автомойки с телефонами, WhatsApp, адресами и датой проверки.\n\nЕсли не актуально — подскажите, кому у вас лучше отправить информацию по B2B-продажам?" 
    },
    { 
      type: "Короткий call script", 
      text: "Добрый день, меня зовут [Имя], компания [Ваша Компания]. Мы специализируемся на верифицированных B2B-базах для авто-рынка Казахстана. Скажите, вы сейчас работаете над увеличением числа активных клиентов в Астане?\n(Пауза, слушаем ответ)\nОтлично. Мы подготовили базу из проверенных автосервисов и магазинов с прямыми телефонами и мессенджерами. Могу я отправить вам короткий sample на WhatsApp прямо сейчас, чтобы вы оценили полноту данных?" 
    }
  ]);
  messagesSheet.getColumn("text").alignment = { wrapText: true };

  // 7. Итоги дня
  const dailyResultsSheet = workbook.addWorksheet("Итоги дня");
  const dailyHeaders = [
    "Дата", "Строк добрали", "Всего проверено", "Покупателей добавили", 
    "Сообщений отправили", "Ответов", "Запросов на 50 строк", 
    "Пилотов обсуждается", "Оплат", "Заметки"
  ];
  dailyResultsSheet.columns = dailyHeaders.map(h => ({ 
    header: h, 
    key: h.toLowerCase().replace(/\s+/g, '_'), 
    width: 20 
  }));
  for (let i = 0; i < 30; i++) {
    dailyResultsSheet.addRow({});
  }

  // Format headers for all sheets
  workbook.eachSheet((sheet) => {
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
  });

  await workbook.xlsx.writeFile(WORKBOOK_PATH);
  console.log(`✅ Sales Sprint Workbook generated successfully at: ${WORKBOOK_PATH}`);
  console.log(`📊 Imported ${existingRowsCount} rows from Real Sample 50.`);
  console.log(`📊 Added ${remainingRows} empty rows to reach 50.`);
}

main().catch((err) => {
  console.error("❌ Failed to generate workbook:", err);
  process.exit(1);
});
