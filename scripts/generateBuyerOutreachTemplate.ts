import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { logger } from "../src/logger.js";

async function generateBuyerOutreachTemplate() {
  const exportDir = "exports";
  fs.mkdirSync(exportDir, { recursive: true });
  const exportPath = path.join(exportDir, "autoservice-radar-buyer-outreach-template.xlsx");

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AutoService Radar KZ";
  workbook.created = new Date();

  // ==========================================
  // 1. Вкладка: Покупатели
  // ==========================================
  const buyersSheet = workbook.addWorksheet("Покупатели");
  const buyerColumns = [
    { header: "Компания", key: "company", width: 30 },
    { header: "Сегмент", key: "segment", width: 25 },
    { header: "Контакт", key: "contact", width: 25 },
    { header: "Канал", key: "channel", width: 15 },
    { header: "Дата отправки", key: "sentDate", width: 15 },
    { header: "Статус ответа", key: "status", width: 25 },
    { header: "Следующее действие", key: "nextAction", width: 25 },
    { header: "Заметки", key: "notes", width: 40 }
  ];
  buyersSheet.columns = buyerColumns;
  buyersSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  buyersSheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4F81BD" }
  };

  // Data Validations (Dropdowns)
  const segmentList = '"Поставщики масел,Поставщики шин,Оптовики автозапчастей,Автохимия,Оборудование для СТО,CRM / телефония / POS"';
  const channelList = '"WhatsApp,Звонок,Email,Instagram,Telegram,Сайт / форма"';
  const statusList = '"Отправлено,Нет ответа,Ответил, есть интерес,Попросил 50 строк,Обсуждаем пилот,Оплатил,Не актуально,Нужен другой контакт,Связаться позже,Отправлен повторный контакт"';

  buyersSheet.getColumn("segment").dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: [segmentList],
    showErrorMessage: true,
    errorTitle: "Неверный сегмент",
    error: "Выберите значение из выпадающего списка."
  };

  buyersSheet.getColumn("channel").dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: [channelList],
    showErrorMessage: true,
    errorTitle: "Неверный канал",
    error: "Выберите значение из выпадающего списка."
  };

  buyersSheet.getColumn("status").dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: [statusList],
    showErrorMessage: true,
    errorTitle: "Неверный статус",
    error: "Выберите значение из выпадающего списка."
  };

  // Add 50 empty rows
  for (let i = 0; i < 50; i++) {
    buyersSheet.addRow({});
  }

  // ==========================================
  // 2. Вкладка: Сегменты (Справочник)
  // ==========================================
  const segmentsSheet = workbook.addWorksheet("Сегменты");
  segmentsSheet.columns = [{ header: "Целевые сегменты покупателей", key: "segment", width: 40 }];
  segmentsSheet.getRow(1).font = { bold: true };
  const segmentsData = [
    "Поставщики масел",
    "Поставщики шин",
    "Оптовики автозапчастей",
    "Автохимия",
    "Оборудование для СТО",
    "CRM / телефония / POS"
  ];
  segmentsSheet.addRows(segmentsData.map(s => ({ segment: s })));

  // ==========================================
  // 3. Вкладка: Статусы (Справочник)
  // ==========================================
  const statusesSheet = workbook.addWorksheet("Статусы");
  statusesSheet.columns = [{ header: "Статусы ответа", key: "status", width: 40 }];
  statusesSheet.getRow(1).font = { bold: true };
  const statusesData = [
    "Отправлено",
    "Нет ответа",
    "Ответил, есть интерес",
    "Попросил 50 строк",
    "Обсуждаем пилот",
    "Оплатил",
    "Не актуально",
    "Нужен другой контакт",
    "Связаться позже",
    "Отправлен повторный контакт"
  ];
  statusesSheet.addRows(statusesData.map(s => ({ status: s })));

  // ==========================================
  // 4. Вкладка: Сообщения
  // ==========================================
  const messagesSheet = workbook.addWorksheet("Сообщения");
  messagesSheet.columns = [
    { header: "Тип сообщения", key: "type", width: 25 },
    { header: "Текст / Скрипт", key: "content", width: 80 }
  ];
  messagesSheet.getRow(1).font = { bold: true };
  
  messagesSheet.addRows([
    {
      type: "Первое WhatsApp-сообщение",
      content: "Здравствуйте. У нас есть проверенная B2B-база автосервисов по Астане: СТО, шиномонтажи, автомойки.\n\nЕсть телефоны, WhatsApp, адреса, сайты/email где доступны, дубли убраны, стоит дата проверки.\n\nЕсли вы продаёте масла, шины, запчасти, автохимию или оборудование для СТО — можем отправить 50 строк для оценки качества бесплатно.\n\nАктуально для вашего отдела продаж?"
    },
    {
      type: "Follow-up (Повторное сообщение)",
      content: "Здравствуйте. Возвращаюсь по базе автосервисов Астаны.\n\nМожем бесплатно отправить 50 строк: СТО/шиномонтажи/автомойки с телефонами, WhatsApp, адресами и датой проверки.\n\nЕсли не актуально — подскажите, кому у вас лучше отправить информацию по B2B-продажам?"
    },
    {
      type: "Короткий Call Script",
      content: "Цель звонка: понять, актуальна ли база автосервисов для отдела продаж, и предложить 50 строк для оценки качества.\n\n\"Добрый день, [Имя]? Меня зовут [Ваше Имя], компания [Ваша Компания]. Мы помогаем поставщикам в авто-сфере находить проверенные СТО и шиномонтажи в Астане. Скажите, вы сейчас работаете над расширением клиентской базы? (Пауза). Отлично, у нас есть база с прямыми телефонами и WhatsApp. Могу я отправить вам 50 строк бесплатно, чтобы вы оценили качество данных?\""
    }
  ]);
  messagesSheet.getColumn("content").alignment = { wrapText: true };

  // ==========================================
  // 5. Вкладка: Цели
  // ==========================================
  const goalsSheet = workbook.addWorksheet("Цели");
  goalsSheet.columns = [
    { header: "Метрика спринта", key: "metric", width: 40 },
    { header: "Целевое значение", key: "target", width: 20 }
  ];
  goalsSheet.getRow(1).font = { bold: true };
  goalsSheet.addRows([
    { metric: "Компаний добавлено в таблицу", target: 50 },
    { metric: "Отправленных сообщений/звонков", target: 50 },
    { metric: "Полученных ответов", target: "10-20" },
    { metric: "Запросов на 50 строк (sample)", target: "3-5" },
    { metric: "Платных пилотов", target: 1 }
  ]);
  goalsSheet.getColumn("metric").font = { bold: true };

  // Save file
  await workbook.xlsx.writeFile(exportPath);
  logger.info(`Buyer outreach template generated successfully at ${exportPath}`);
  console.log(`\n✅ Шаблон успешно создан: ${exportPath}`);
}

generateBuyerOutreachTemplate().catch((err) => {
  logger.error("Failed to generate buyer outreach template", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
