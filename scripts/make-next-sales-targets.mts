import ExcelJS from "exceljs";

type Priority = "A" | "B" | "C";

interface SegmentRow {
  priority: Priority;
  segment: string;
  buyerLogic: string;
  bestOffer: string;
  firstDataSlice: string;
  channel: string;
  priceTest: string;
  risk: string;
}

interface AccountRow {
  priority: Priority;
  company: string;
  segment: string;
  website: string;
  buyerRole: string;
  whyFit: string;
  firstPitch: string;
  nextStep: string;
  source: string;
  status: string;
}

const OUTPUT_PATH = "exports/next-sales-targets.xlsx";

const segments: SegmentRow[] = [
  {
    priority: "A",
    segment: "Тендерные порталы, сопровождение и консалтинг",
    buyerLogic: "Они уже продают доступ к тендерам, аналитику, обучение, помощь с документами и финансированием; свежие победители дополняют их продукт как upsell и контент для продаж.",
    bestOffer: "Еженедельный файл: новые победители + суммы + заказчики + контакты + отрасль; white-label/API для их клиентов.",
    firstDataSlice: "50 свежих победителей за неделю по 3-5 популярным категориям.",
    channel: "Email/LinkedIn основателям или руководителю продукта; затем звонок.",
    priceTest: "100-250k KZT/month или 30-50k KZT за разовый vertical digest.",
    risk: "Могут считать это конкурентным продуктом; заходить как источник данных/партнерский фид, не как замена их сервису."
  },
  {
    priority: "A",
    segment: "Поставщики стройматериалов и дорожно-строительной техники",
    buyerLogic: "Победитель строительного/ремонтного тендера быстро закупает материалы, технику, расходники и услуги. В локальной базе уже есть контакты из 2GIS.",
    bestOffer: "Список компаний с активными/новыми строительными контрактами: сумма, заказчик, город, директор, телефон.",
    firstDataSlice: "Top-30 строительных подрядчиков Астана/Алматы из `kz-top-a-sample-3.xlsx` (короткий sample на 3 строки как proof-of-data).",
    channel: "WhatsApp сначала, затем звонок через день.",
    priceTest: "50k KZT разово; если покупают, weekly city/category digest 100-150k KZT/month.",
    risk: "Малые поставщики покупают только если видят конкретных подрядчиков под свой товар; нужна узкая категория."
  },
  {
    priority: "A",
    segment: "Лизинг и продавцы оборудования/спецтехники",
    buyerLogic: "Контракт создает потребность в технике, транспорте, сельхоз/строительном оборудовании и оборотке на аванс.",
    bestOffer: "Лиды победителей с суммой контракта и типом работ, где вероятна покупка техники или лизинг.",
    firstDataSlice: "Победители по строительству, коммунальным услугам, сельхоз/технике, перевозкам.",
    channel: "Email + LinkedIn/звонок в отдел продаж/партнерств.",
    priceTest: "150-300k KZT/month за еженедельный фид; пилот бесплатно 20 строк.",
    risk: "Нужна квалификация по предмету закупки, иначе лизингам будет слишком шумно."
  },
  {
    priority: "B",
    segment: "Логистика, грузоперевозки, складские услуги",
    buyerLogic: "Победители по поставкам товаров часто нуждаются в доставке, хранении, таможне и экспедировании.",
    bestOffer: "Дайджест победителей по товарным категориям с городом заказчика и сроком исполнения.",
    firstDataSlice: "Поставки мебели, оборудования, продуктов, стройматериалов, медизделий.",
    channel: "Через KazLogistics/ассоциации и прямой WhatsApp локальным перевозчикам.",
    priceTest: "50-100k KZT за категорийный список; 100-200k KZT/month при регулярности.",
    risk: "Если нет маршрута/объема поставки, ценность ниже; нужно вытаскивать регион заказчика и предмет."
  },
  {
    priority: "B",
    segment: "1C/ERP/ЭДО, бухгалтерия и автоматизация",
    buyerLogic: "Победитель тендера начинает документооборот, ЭСФ/ЭАВР, учет запасов, отчетность и управление заказами.",
    bestOffer: "Лиды компаний, которые впервые/активно заходят в госзаказ и могут купить учет/ЭДО/ERP-настройку.",
    firstDataSlice: "Новые победители МСБ с контрактами 5-100 млн KZT и контактами директора.",
    channel: "Email руководителю продаж/партнерской сети, затем звонок.",
    priceTest: "100-200k KZT/month; возможна CPA-модель за назначенную встречу.",
    risk: "Нужно доказать, что лиды не просто тендерные, а с реальной операционной нагрузкой."
  },
  {
    priority: "B",
    segment: "Damu/консалтинг по господдержке и бизнес-планам",
    buyerLogic: "Компании с контрактом могут искать субсидии, гарантии, льготное кредитование, бизнес-план и сопровождение заявки.",
    bestOffer: "Партнерский фид для консультантов: победители, кому скоро нужна оборотка/гарантия/субсидирование.",
    firstDataSlice: "Победители МСБ 10-300 млн KZT, особенно регионы.",
    channel: "Партнерства, консалтинговые компании, региональные бизнес-центры.",
    priceTest: "Пилот 1 регион/1 отрасль; затем revenue share или 100k KZT/month.",
    risk: "Госинституты сами могут не покупать; лучше через частных консультантов и банки-партнеры."
  },
  {
    priority: "C",
    segment: "Страхование и брокеры",
    buyerLogic: "У подрядчиков появляются риски по ответственности, грузу, технике, имуществу и сотрудникам.",
    bestOffer: "Список победителей крупных контрактов с типом работ и регионом.",
    firstDataSlice: "Контракты от 50 млн KZT, строительство/перевозка/оборудование.",
    channel: "Только после доказательства на A/B сегментах.",
    priceTest: "CPA за квалифицированный лид или 50k KZT за тестовый список.",
    risk: "Потребность менее очевидна, чем у финансирования/поставщиков."
  }
];

const accounts: AccountRow[] = [
  {
    priority: "A",
    company: "Tenderbot.kz",
    segment: "Тендерный портал / сопровождение",
    website: "https://tenderbot.kz/",
    buyerRole: "founder / product / partnerships",
    whyFit: "Сервис продает ежедневную рассылку, поиск тендера, аналитику, обучение, юрпомощь и финансирование под контракт.",
    firstPitch: "Дадим фид свежих победителей как отдельный модуль аналитики/upsell для ваших клиентов.",
    nextStep: "Отправить sample 50 победителей + предложить white-label weekly digest.",
    source: "https://tenderbot.kz/",
    status: "new"
  },
  {
    priority: "A",
    company: "MITWORK / GetContract",
    segment: "Закупочная платформа / контрагенты",
    website: "https://www.mitwork.kz/",
    buyerRole: "product / business development / GetContract",
    whyFit: "MITWORK развивает ЕЭП, EDOC.KZ и GetContract; на сайте заявлены закупочная платформа, контрагентская аналитика и 700 новых закупок еженедельно.",
    firstPitch: "Фид победителей госзакупок может усилить GetContract: кто выиграл, у кого контракт, кому продавать/проверять.",
    nextStep: "Написать на info@mitwork.kz и найти product lead GetContract/ЕЭП.",
    source: "https://www.mitwork.kz/",
    status: "new"
  },
  {
    priority: "A",
    company: "KazAgroFinance",
    segment: "Агро-лизинг",
    website: "https://kaf.kz/",
    buyerRole: "sales / regional branches / partnerships",
    whyFit: "Финансирует покупку техники и оборудования через региональные филиалы; у победителей агро/коммунальных/поставочных тендеров может возникать спрос на технику.",
    firstPitch: "Еженедельный список компаний, выигравших контракты, где нужна техника/оборудование.",
    nextStep: "Начать с регионального филиала и центрального отдела продаж, приложить отраслевой sample.",
    source: "https://kaf.kz/",
    status: "new"
  },
  {
    priority: "A",
    company: "Li Trade",
    segment: "Дорожно-строительная техника",
    website: "https://litrade.kz",
    buyerRole: "sales director / owner",
    whyFit: "Уже есть в локальном `prospects-segment1.xlsx`; продает дорожно-строительную технику в Астане.",
    firstPitch: "30 строительных/дорожных подрядчиков с активными контрактами и телефонами.",
    nextStep: "WhatsApp: отправить sample-файл, затем звонок.",
    source: "exports/prospects-segment1.xlsx",
    status: "new"
  },
  {
    priority: "A",
    company: "SERILIK-M CONSTRUCTION",
    segment: "Стройматериалы",
    website: "https://www.srm2.kz",
    buyerRole: "owner / sales",
    whyFit: "Есть в локальном списке, склад строительных материалов, контакты и WhatsApp доступны.",
    firstPitch: "Список строительных компаний, которые прямо сейчас исполняют госконтракты.",
    nextStep: "WhatsApp + sample `kz-top-a-sample-3.xlsx`.",
    source: "exports/prospects-segment1.xlsx",
    status: "new"
  },
  {
    priority: "A",
    company: "ТИЫН",
    segment: "Стройматериалы",
    website: "https://tiyn-td.kz",
    buyerRole: "owner / sales",
    whyFit: "Магазин стройматериалов из локальной базы; есть телефон, WhatsApp и email.",
    firstPitch: "Подрядчики с новыми контрактами = горячие покупатели стройматериалов.",
    nextStep: "WhatsApp first, then call.",
    source: "exports/prospects-segment1.xlsx",
    status: "new"
  },
  {
    priority: "A",
    company: "Авангард Снаб",
    segment: "Стройматериалы",
    website: "https://www.largo.kz",
    buyerRole: "owner / sales",
    whyFit: "Локальный поставщик стройматериалов в Астане с телефоном/WhatsApp.",
    firstPitch: "Дадим строительных подрядчиков с подтвержденным бюджетом и сроком работ.",
    nextStep: "WhatsApp + sample-файл, затем звонок.",
    source: "exports/prospects-segment1.xlsx",
    status: "new"
  },
  {
    priority: "A",
    company: "masterstroi.kz",
    segment: "Стройматериалы",
    website: "https://master-stroy-kz.satu.kz",
    buyerRole: "owner / sales",
    whyFit: "Локальный поставщик строительных материалов в Астане с WhatsApp.",
    firstPitch: "Покажем топ подрядчиков Астана/Алматы с активными госконтрактами.",
    nextStep: "WhatsApp + follow-up call next day.",
    source: "exports/prospects-segment1.xlsx",
    status: "new"
  },
  {
    priority: "B",
    company: "KAZLOGISTICS",
    segment: "Логистика / ассоциация / канал",
    website: "https://www.kazlogistics.kz/",
    buyerRole: "partnerships / members relations",
    whyFit: "Союз транспортников Казахстана объединяет направления авто, железнодорожного, водного, авиа и транспортной логистики.",
    firstPitch: "Партнерский фид для членов союза: победители товарных тендеров, которым нужна доставка/склад.",
    nextStep: "Написать на info@kazlogistics.kz с предложением пилота для членов.",
    source: "https://www.kazlogistics.kz/",
    status: "new"
  },
  {
    priority: "B",
    company: "1C-Rating",
    segment: "1C / ЭДО / автоматизация",
    website: "https://1c-rating.kz/",
    buyerRole: "head of sales / partner channel / corporate business",
    whyFit: "Продает сопровождение 1С, ЭДО для Казахстана, 1С в облаке, ЭСФ/ЭАВР/СНТ и учет заказов.",
    firstPitch: "Новые победители тендеров как лиды на ЭДО, учет заказов, склад/инвентаризацию и отчетность.",
    nextStep: "Email руководителю продаж: предложить CPA/pilot 30 лидов.",
    source: "https://1c-rating.kz/",
    status: "new"
  },
  {
    priority: "B",
    company: "Damu + частные консалтинговые партнеры",
    segment: "Господдержка / консультанты",
    website: "https://damu.kz/",
    buyerRole: "partner network / consulting companies",
    whyFit: "Damu показывает программы гарантирования, субсидирования и льготного финансирования; победители контрактов часто ищут поддержку оборотки.",
    firstPitch: "Фид компаний с новым контрактом для консультантов по субсидиям/гарантиям.",
    nextStep: "Искать не только Damu, а консалтинговые компании вокруг Damu; предложить региональный pilot.",
    source: "https://damu.kz/",
    status: "new"
  },
  {
    priority: "B",
    company: "Консалтинг Строй Груп",
    segment: "Проектирование / документы",
    website: "https://stroy-dokument.tilda.ws",
    buyerRole: "owner / sales",
    whyFit: "Локальная компания по архитектурно-строительному проектированию; подрядчикам с контрактами могут нужны документы/узаконение/проектные услуги.",
    firstPitch: "Список строительных подрядчиков с новыми/активными контрактами.",
    nextStep: "WhatsApp: прислать 3-строчный sample `kz-top-a-sample-3.xlsx` как proof-of-data, затем звонок.",
    source: "exports/prospects-segment1.xlsx",
    status: "new"
  }
];

const messages = [
  {
    use: "Tender portals / analytics",
    copy: "Добрый день! Мы собираем еженедельный фид свежих победителей госзакупок РК: БИН, сумма, заказчик, категория, контакты директора. Видим, что у вас уже есть сервис для участников тендеров; такой фид можно добавить как аналитику/upsell для клиентов. Могу прислать 50 строк за прошлую неделю как sample?"
  },
  {
    use: "Construction suppliers",
    copy: "Здравствуйте! У нас есть список строительных компаний, которые прямо сейчас исполняют госконтракты: суммы, заказчики, телефоны, директора. Могу прислать 3 строки бесплатно как proof-of-data, полный список — 50 000 ₸. Интересно?"
  },
  {
    use: "Leasing / equipment",
    copy: "Добрый день! Собираем победителей госзакупок РК, где после выигрыша возникает потребность в технике/оборудовании/транспорте. В файле: компания, БИН, сумма контракта, заказчик, предмет закупки, контакты. Готов прислать 20 строк бесплатно как пилот для оценки fit."
  },
  {
    use: "1C / automation",
    copy: "Добрый день! Победитель тендера часто запускает ЭДО, ЭСФ/ЭАВР, учет заказов, склад и отчетность. Мы можем еженедельно давать список новых победителей с контактами директора и суммой контракта. Интересно проверить как источник лидов для 1С/ЭДО?"
  }
];

const sources = [
  ["goszakup.gov.kz", "Официальный портал ГЗ РК: зарегистрированные пользователи, поиск заказов/лотов/объявлений, реестры договоров и TOP поставщиков.", "https://goszakup.gov.kz/"],
  ["MITWORK", "ЕЭП, EDOC.KZ, GetContract; сайт указывает закупочную платформу, контрагентскую аналитику и 700 новых закупок еженедельно.", "https://www.mitwork.kz/"],
  ["Tenderbot.kz", "Портал продает ежедневную рассылку, поиск тендера, аналитику, обучение, юрпомощь и финансирование под контракт.", "https://tenderbot.kz/"],
  ["KazAgroFinance", "Региональные филиалы и финансирование техники/оборудования для АПК; полезно для гипотезы лизинга.", "https://kaf.kz/"],
  ["Damu", "Программы поддержки МСБ: гарантии, субсидирование, льготное финансирование; релевантно консультантам по господдержке.", "https://damu.kz/"],
  ["KAZLOGISTICS", "Союз транспортников Казахстана; направления авто, ж/д, водный, авиа транспорт и транспортная логистика.", "https://www.kazlogistics.kz/"],
  ["1C-Rating", "1С, ЭДО, ЭСФ/ЭАВР/СНТ, учет заказов, облако и корпоративное внедрение.", "https://1c-rating.kz/"],
  ["Local prospects", "Поставщики стройматериалов/техники из уже созданного локального файла.", "exports/prospects-segment1.xlsx"]
];

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 36;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function setHyperlink(cell: ExcelJS.Cell, url: string): void {
  if (!url || url.startsWith("exports/")) return;
  cell.value = { text: url, hyperlink: url };
  cell.font = { color: { argb: "FF0563C1" }, underline: true };
}

function applyCommon(sheet: ExcelJS.Worksheet): void {
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: "top", wrapText: rowNumber !== 1 };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

const wb = new ExcelJS.Workbook();
wb.creator = "Scrape2Lead";
wb.created = new Date();

const summary = wb.addWorksheet("Recommendation");
summary.columns = [
  { header: "Item", key: "item", width: 28 },
  { header: "Recommendation", key: "recommendation", width: 110 }
];
summary.addRows([
  {
    item: "Best next wave",
    recommendation: "1) Tender portals/consultants, 2) construction suppliers already in prospects-segment1.xlsx, 3) leasing/equipment sellers. These three have the clearest direct monetization from a new-contract signal."
  },
  {
    item: "First 48 hours",
    recommendation: "Send 10-15 highly specific messages, not a broad blast: 3 tender platforms/consultants, 7 construction suppliers from the local file, 3 leasing/equipment accounts."
  },
  {
    item: "Best package",
    recommendation: "Do not sell 'data'. Sell a weekly buyer-specific digest: who won, amount, buyer, why they need your product now, phone/director/email."
  },
  {
    item: "Pricing test",
    recommendation: "Small suppliers: 50k KZT one-off. Tender/finance/leasing/ERP: 100-300k KZT/month after free pilot."
  },
  {
    item: "Main caveat",
    recommendation: "Generic goszakup data is commoditized. The paid value is filtering by buyer use case and adding contact/next-action fields."
  }
]);
styleHeader(summary);
summary.getColumn("recommendation").alignment = { wrapText: true, vertical: "top" };

const segSheet = wb.addWorksheet("Segments");
segSheet.columns = [
  { header: "priority", key: "priority", width: 10 },
  { header: "segment", key: "segment", width: 34 },
  { header: "why they buy", key: "buyerLogic", width: 54 },
  { header: "best offer", key: "bestOffer", width: 54 },
  { header: "first data slice", key: "firstDataSlice", width: 42 },
  { header: "channel", key: "channel", width: 28 },
  { header: "price test", key: "priceTest", width: 32 },
  { header: "risk", key: "risk", width: 44 }
];
segSheet.addRows(segments);
styleHeader(segSheet);
applyCommon(segSheet);

const accSheet = wb.addWorksheet("Account targets");
accSheet.columns = [
  { header: "priority", key: "priority", width: 10 },
  { header: "company", key: "company", width: 28 },
  { header: "segment", key: "segment", width: 28 },
  { header: "website", key: "website", width: 34 },
  { header: "buyer role", key: "buyerRole", width: 30 },
  { header: "why fit", key: "whyFit", width: 54 },
  { header: "first pitch", key: "firstPitch", width: 52 },
  { header: "next step", key: "nextStep", width: 42 },
  { header: "source", key: "source", width: 34 },
  { header: "status", key: "status", width: 16 }
];
for (const account of accounts) {
  const row = accSheet.addRow(account);
  setHyperlink(row.getCell("website"), account.website);
  setHyperlink(row.getCell("source"), account.source);
}
styleHeader(accSheet);
applyCommon(accSheet);

const msgSheet = wb.addWorksheet("Messages");
msgSheet.columns = [
  { header: "use", key: "use", width: 28 },
  { header: "copy", key: "copy", width: 120 }
];
msgSheet.addRows(messages);
styleHeader(msgSheet);
msgSheet.getColumn("copy").alignment = { wrapText: true, vertical: "top" };

const sourceSheet = wb.addWorksheet("Sources");
sourceSheet.columns = [
  { header: "source", key: "source", width: 28 },
  { header: "what it supports", key: "supports", width: 100 },
  { header: "url / file", key: "url", width: 44 }
];
for (const source of sources) {
  const row = sourceSheet.addRow({ source: source[0], supports: source[1], url: source[2] });
  setHyperlink(row.getCell("url"), source[2]);
}
styleHeader(sourceSheet);
sourceSheet.getColumn("supports").alignment = { wrapText: true, vertical: "top" };

for (const sheet of wb.worksheets) {
  sheet.properties.defaultRowHeight = 24;
}

await wb.xlsx.writeFile(OUTPUT_PATH);
console.log(`next sales targets: ${accounts.length} accounts, ${segments.length} segments -> ${OUTPUT_PATH}`);
