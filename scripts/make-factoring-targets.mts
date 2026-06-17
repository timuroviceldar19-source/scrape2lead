import ExcelJS from "exceljs";

type Priority = "A" | "B" | "C";

interface TargetRow {
  company: string;
  type: string;
  website: string;
  factoringPage: string;
  smeCorpLending: string;
  procurementFinance: string;
  city: string;
  contactName: string;
  role: string;
  phone: string;
  email: string;
  linkedInTelegram: string;
  priority: Priority;
  status: string;
  nextStep: string;
  notes: string;
}

const OUTPUT_PATH = "exports/factoring-targets.xlsx";

const rows: TargetRow[] = [
  {
    company: "Halyk Bank",
    type: "bank",
    website: "https://halykbank.kz/business",
    factoringPage: "https://halykbank.kz/business/credit/cifrovoi-faktoring",
    smeCorpLending: "Business credits and SME products",
    procurementFinance: "Цифровой факторинг для поставщиков по госзакупкам",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: МСБ / цифровой факторинг / госзакупки",
    phone: "",
    email: "",
    linkedInTelegram: "LinkedIn: Halyk Bank / Halyk Business",
    priority: "A",
    status: "new",
    nextStep: "Найти владельца продукта цифрового факторинга и отправить пилот 10 строк",
    notes: "Явный язык госзакупок и факторинга; один из первых 5 контактов."
  },
  {
    company: "Bank CenterCredit (BCC)",
    type: "bank",
    website: "https://www.bcc.kz/en/business/",
    factoringPage: "https://www.bcc.kz/en/business/loans/factoring/",
    smeCorpLending: "Factoring; Purchase Order Financing; Distributor Financing",
    procurementFinance: "Guarantees and business finance products",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "head/product manager: factoring / business loans / SME",
    phone: "",
    email: "",
    linkedInTelegram: "LinkedIn: Bank CenterCredit",
    priority: "A",
    status: "new",
    nextStep: "Найти контакт направления factoring/business loans; отправить email + LinkedIn",
    notes: "На сайте есть отдельный продукт Factoring."
  },
  {
    company: "Eurasian Bank",
    type: "bank",
    website: "https://eubank.kz/ru/business",
    factoringPage: "https://eubank.kz/ru/factoring-business",
    smeCorpLending: "Business factoring via Electronic Factoring Center platform",
    procurementFinance: "Факторинг для участников государственных закупок",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: факторинг / бизнес",
    phone: "+7 (727) 332 77 22",
    email: "TF@eubank.kz",
    linkedInTelegram: "LinkedIn: Eurasian Bank",
    priority: "A",
    status: "new",
    nextStep: "Отправить короткое письмо на trade finance и найти продуктового ЛПР",
    notes: "На старой странице trade finance опубликован TF email; проверить актуальность перед рассылкой."
  },
  {
    company: "F2B.kz",
    type: "factoring platform",
    website: "https://f2b.kz/eng/",
    factoringPage: "https://f2b.kz/eng/about",
    smeCorpLending: "Online factoring platform; supplier/customer factoring",
    procurementFinance: "Supplier factoring for large buyers and quasi-state customers",
    city: "Astana / Almaty / Kazakhstan",
    contactName: "",
    role: "founder / sales lead / partnerships",
    phone: "+7 700 504 43 85",
    email: "www.f2b.kz@gmail.com",
    linkedInTelegram: "Instagram/site form",
    priority: "A",
    status: "new",
    nextStep: "WhatsApp/email: предложить еженедельный поток победителей госзакупок",
    notes: "Чистый factoring buyer; вероятно быстрее банков по обратной связи."
  },
  {
    company: "First Factoring Company",
    type: "factoring company",
    website: "https://1factoring.kz/",
    factoringPage: "https://1factoring.kz/",
    smeCorpLending: "Услуги факторинга; онлайн факторинг",
    procurementFinance: "Факторинг для поставщиков с отсрочкой платежа",
    city: "Almaty",
    contactName: "",
    role: "commercial director / sales / factoring",
    phone: "+7 777 270 83 57",
    email: "info@1factoring.kz",
    linkedInTelegram: "LinkedIn: First Factoring Company",
    priority: "A",
    status: "new",
    nextStep: "Отправить письмо + позвонить после отправки",
    notes: "Специализированная факторинговая компания; высокий fit."
  },
  {
    company: "Factor Capital",
    type: "factoring company",
    website: "https://factor-capital.kz/",
    factoringPage: "https://factor-capital.kz/ru/factoring-regressnii-for-postavjska/",
    smeCorpLending: "Факторинг с регрессом; безрегрессный; предпоставочный; международный",
    procurementFinance: "Факторинг для компаний, работающих по тендерным поставкам",
    city: "Almaty",
    contactName: "",
    role: "sales / factoring agents / commercial",
    phone: "+7 (727) 328 33 67",
    email: "info@factor-capital.kz",
    linkedInTelegram: "site form",
    priority: "A",
    status: "new",
    nextStep: "Email на общий адрес; в теме указать свежие победители тендеров",
    notes: "Сайт прямо упоминает тендерные поставки в продукте факторинга."
  },
  {
    company: "Industrial Factoring Company (IFC)",
    type: "factoring company",
    website: "https://www.factoring.com.kz/",
    factoringPage: "https://www.factoring.com.kz/",
    smeCorpLending: "Факторинг и выкуп дебиторской задолженности",
    procurementFinance: "Финансирование поставщиков и receivables purchase",
    city: "Almaty",
    contactName: "",
    role: "founder / sales / factoring",
    phone: "+7 777 121 6161; +7 708 831 3522",
    email: "ifactoringcompany@gmail.com",
    linkedInTelegram: "WhatsApp from site",
    priority: "A",
    status: "new",
    nextStep: "WhatsApp с пилотом 10 строк; затем email",
    notes: "Небольшой факторинг, вероятно быстрый цикл ответа."
  },
  {
    company: "Bereke Bank",
    type: "bank",
    website: "https://berekebank.kz/ru/small_business",
    factoringPage: "https://berekebank.kz/ru/about/documents",
    smeCorpLending: "Small business credits; factoring documents",
    procurementFinance: "Гарантии для бизнеса; цифровые тендерные бланковые гарантии",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: guarantees / factoring / small business",
    phone: "",
    email: "",
    linkedInTelegram: "LinkedIn: Bereke Bank",
    priority: "A",
    status: "new",
    nextStep: "Найти ЛПР по гарантиям/факторингу; предложить пилот",
    notes: "Явный закупочный сигнал через гарантии; факторинг виден в документах/FAQ."
  },
  {
    company: "Freedom Bank",
    type: "bank",
    website: "https://bankffin.kz/ru",
    factoringPage: "",
    smeCorpLending: "Business banking and guarantees",
    procurementFinance: "Банковские гарантии; цифровые бланковые тендерные гарантии",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: bank guarantees / Freedom Business",
    phone: "",
    email: "",
    linkedInTelegram: "LinkedIn: Freedom Bank Kazakhstan",
    priority: "B",
    status: "new",
    nextStep: "Искать владельца продукта гарантий; отправить LinkedIn/email",
    notes: "Нет явного факторинга в проверенной ссылке, но сильный сигнал по тендерным гарантиям."
  },
  {
    company: "Bank RBK",
    type: "bank",
    website: "https://bankrbk.kz/ru/msb",
    factoringPage: "",
    smeCorpLending: "MSB/corporate business lending and guarantees",
    procurementFinance: "Тендерные и банковские гарантии для МСБ/корпоративного бизнеса",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: guarantees / MSB / corporate",
    phone: "+7 (727) 330 90 30",
    email: "",
    linkedInTelegram: "LinkedIn: Bank RBK",
    priority: "B",
    status: "new",
    nextStep: "Позвонить в направление гарантий и запросить email продуктового владельца",
    notes: "Сильный закупочный язык: тендерные гарантии, посттендерные гарантии, платеж по контракту."
  },
  {
    company: "Altyn Bank",
    type: "bank",
    website: "https://altynbank.kz/ru/business",
    factoringPage: "",
    smeCorpLending: "Business banking; guarantees; letters of credit",
    procurementFinance: "Электронные тендерные гарантии для госзакупок и Самрук-Казына",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: bank guarantees / business",
    phone: "+7 727 356 57 77",
    email: "",
    linkedInTelegram: "LinkedIn: Altyn Bank",
    priority: "B",
    status: "new",
    nextStep: "Отправить через форму заявки/контакт-центр запрос на ЛПР по гарантиям",
    notes: "Есть прямой сигнал по госзакупкам и Самрук-Казына."
  },
  {
    company: "Alatau City Bank (Jusan)",
    type: "bank",
    website: "https://jusan.kz/business",
    factoringPage: "",
    smeCorpLending: "Овердрафт под оборот; кредиты для бизнеса",
    procurementFinance: "Банковские гарантии; тендерные гарантии",
    city: "Astana / Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: guarantees / business credits",
    phone: "+7 (717) 258 77 11; 7711",
    email: "business@alataucitybank.kz",
    linkedInTelegram: "LinkedIn: Alatau City Bank / Jusan",
    priority: "B",
    status: "new",
    nextStep: "Email на business@ + поиск владельца направления гарантий в LinkedIn",
    notes: "Хороший B: гарантии и оборотка, но нет явной страницы факторинга."
  },
  {
    company: "ForteBank",
    type: "bank",
    website: "https://business.forte.kz/ru",
    factoringPage: "",
    smeCorpLending: "Forte Business credits and business banking",
    procurementFinance: "Банковские гарантии / тендерные гарантии для бизнеса",
    city: "Astana / Almaty / Kazakhstan",
    contactName: "",
    role: "product owner: business guarantees / SME",
    phone: "55575",
    email: "",
    linkedInTelegram: "LinkedIn: ForteBank / Forte Business",
    priority: "B",
    status: "new",
    nextStep: "LinkedIn first; затем запрос в бизнес-контакт по владельцу тендерных гарантий",
    notes: "В первую волну только если есть контакт ЛПР; общий канал может быть медленным."
  },
  {
    company: "KMF Bank",
    type: "bank / SME lender",
    website: "https://kmf.kz/",
    factoringPage: "",
    smeCorpLending: "Кредит для бизнеса на оборотные и основные средства",
    procurementFinance: "Нет явного тендерного продукта; possible working-capital fit",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "head of SME lending / business development",
    phone: "",
    email: "info@kmf.kz",
    linkedInTelegram: "LinkedIn: KMF Bank",
    priority: "B",
    status: "new",
    nextStep: "Проверить интерес к лидам победителей тендеров для кредитования оборотки",
    notes: "Near-fit: не факторинг, но финансирует МСБ и оборотные средства."
  },
  {
    company: "Solva",
    type: "MFO / SME lender",
    website: "https://solva.kz/business/",
    factoringPage: "",
    smeCorpLending: "Кредиты для ИП/ТОО и малого бизнеса",
    procurementFinance: "Нет явного тендерного продукта",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "business lending / partnerships / growth",
    phone: "",
    email: "",
    linkedInTelegram: "LinkedIn: Solva / Solva Global",
    priority: "C",
    status: "new",
    nextStep: "Оставить на вторую волну после банков/факторингов",
    notes: "Near-finance: возможен интерес к сигналам, но оффер хуже совпадает с факторингом."
  },
  {
    company: "Kaspi Pay / Kaspi Business",
    type: "bank / SME lender",
    website: "https://guide.kaspi.kz/partner/ru/business_kredit",
    factoringPage: "",
    smeCorpLending: "Бизнес Кредит / кредит для ИП",
    procurementFinance: "Нет явного тендерного продукта",
    city: "Almaty / Kazakhstan",
    contactName: "",
    role: "Kaspi Pay business lending / partnerships",
    phone: "",
    email: "",
    linkedInTelegram: "LinkedIn: Kaspi.kz",
    priority: "C",
    status: "new",
    nextStep: "Не трогать в первой неделе без теплого интро",
    notes: "Большой канал, но продукт скорее массовый кредит, не факторинг/госзакупки."
  }
];

function applyHeaderStyle(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 34;
}

function addDropdown(sheet: ExcelJS.Worksheet, range: string, values: string[]): void {
  sheet.dataValidations.add(range, {
    type: "list",
    allowBlank: true,
    formulae: [`"${values.join(",")}"`]
  });
}

function setHyperlink(cell: ExcelJS.Cell, text: string): void {
  if (!text) return;
  cell.value = { text, hyperlink: text };
  cell.font = { color: { argb: "FF0563C1" }, underline: true };
}

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Scrape2Lead";
  wb.created = new Date();

  const summary = wb.addWorksheet("Plan");
  summary.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Value", key: "value", width: 90 }
  ];
  summary.addRows([
    { metric: "Goal", value: "Validate segment 2: banks/factoring buyers for weekly digest-winners leads." },
    { metric: "First wave", value: "Send 5 highly targeted messages with a 10-row sample, not the full digest." },
    { metric: "Priority A", value: "Explicit factoring or factoring-for-goszakup language." },
    { metric: "Priority B", value: "Tender guarantees, purchase/order/distributor finance, or SME working capital." },
    { metric: "Priority C", value: "Near-finance: SME lending without a clear procurement/factoring product." },
    { metric: "Target result", value: "2 replies asking for more data; then quote 150-300k KZT/month for weekly niche digest." }
  ]);
  applyHeaderStyle(summary);
  summary.getColumn("value").alignment = { wrapText: true, vertical: "top" };
  summary.views = [{ state: "frozen", ySplit: 1 }];

  const sheet = wb.addWorksheet("Targets");
  sheet.columns = [
    { header: "company", key: "company", width: 28 },
    { header: "type", key: "type", width: 20 },
    { header: "website", key: "website", width: 30 },
    { header: "factoring page", key: "factoringPage", width: 36 },
    { header: "SME/корп lending", key: "smeCorpLending", width: 42 },
    { header: "госзакупки/тендерное финансирование", key: "procurementFinance", width: 42 },
    { header: "city", key: "city", width: 20 },
    { header: "contact name", key: "contactName", width: 22 },
    { header: "role", key: "role", width: 34 },
    { header: "phone", key: "phone", width: 26 },
    { header: "email", key: "email", width: 28 },
    { header: "LinkedIn/Telegram", key: "linkedInTelegram", width: 30 },
    { header: "priority", key: "priority", width: 10 },
    { header: "status", key: "status", width: 18 },
    { header: "next step", key: "nextStep", width: 44 },
    { header: "notes", key: "notes", width: 54 }
  ];

  rows.forEach((target) => {
    const added = sheet.addRow({
      ...target
    });
    setHyperlink(added.getCell("website"), target.website);
    setHyperlink(added.getCell("factoringPage"), target.factoringPage);
  });

  applyHeaderStyle(sheet);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "P1" };
  sheet.getColumn("smeCorpLending").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("procurementFinance").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("role").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("nextStep").alignment = { wrapText: true, vertical: "top" };
  sheet.getColumn("notes").alignment = { wrapText: true, vertical: "top" };

  addDropdown(sheet, "M2:M200", ["A", "B", "C"]);
  addDropdown(sheet, "N2:N200", ["new", "contact found", "sent", "follow-up", "replied", "pilot", "won", "lost", "later"]);

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const priority = row.getCell("priority").value;
    if (priority === "A") {
      row.getCell("priority").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
    } else if (priority === "B") {
      row.getCell("priority").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEB9C" } };
    } else {
      row.getCell("priority").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };
    }
    row.alignment = { vertical: "top" };
  });

  const messages = wb.addWorksheet("Message");
  messages.columns = [
    { header: "Use", key: "use", width: 26 },
    { header: "Copy", key: "copy", width: 110 }
  ];
  messages.addRows([
    {
      use: "Email / LinkedIn",
      copy: [
        "Тема: Лиды для факторинга - свежие победители госзакупок",
        "",
        "Добрый день!",
        "",
        "Делаю аналитику по госзакупкам РК. Готов еженедельно поставлять список компаний, которые только что выиграли тендеры: БИН, сумма контракта, заказчик, телефон директора.",
        "",
        "Победитель тендера - горячий лид для факторинга и банковских гарантий: деньги по контракту придут через месяцы, оборотные средства нужны сейчас.",
        "",
        "Готов прислать прошлую неделю бесплатно как пилот. Интересно?"
      ].join("\n")
    },
    {
      use: "First sample",
      copy: "Прикладывать 10 строк из exports/digest-winners-2026-06-10.xlsx, а не полный файл. Цель письма - ответ 'пришлите еще', не продажа подписки в первом касании."
    },
    {
      use: "Follow-up",
      copy: "Добрый день! Возвращаюсь по списку свежих победителей госзакупок. Если такие лиды не ваша зона, подскажите, пожалуйста, кто отвечает за факторинг/гарантии/МСБ-продукты?"
    }
  ]);
  applyHeaderStyle(messages);
  messages.getColumn("copy").alignment = { wrapText: true, vertical: "top" };
  messages.views = [{ state: "frozen", ySplit: 1 }];

  await wb.xlsx.writeFile(OUTPUT_PATH);
  console.log(`factoring targets: ${rows.length} rows -> ${OUTPUT_PATH}`);
}

await main();
