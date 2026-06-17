import Database from "better-sqlite3";
import ExcelJS from "exceljs";

// Прямые клиенты сегмента 1: поставщики, которым нужны строители с деньгами.
// Строительные КОМПАНИИ исключаем — они продукт, а не покупатель.
const SUPPLIER_CATEGORY_PATTERNS = ["%материал%", "%техник%", "%проектирован%"];

const db = new Database("data/scrape2lead.db");

const rows = db.prepare(`
  SELECT company_name, category, city, phone_normalized, phones, email, website, messenger_links, address_clean, address
  FROM leads
  WHERE source = '2gis'
    AND (${SUPPLIER_CATEGORY_PATTERNS.map(() => "category LIKE ?").join(" OR ")})
  ORDER BY city, category, company_name
`).all(...SUPPLIER_CATEGORY_PATTERNS) as Array<Record<string, string | null>>;

function firstPhone(row: Record<string, string | null>): string {
  if (row.phone_normalized?.trim()) return row.phone_normalized.trim();
  try {
    const parsed = JSON.parse(row.phones ?? "[]") as string[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.join(", ");
  } catch { /* ignore */ }
  return "";
}

function hasWhatsApp(row: Record<string, string | null>): boolean {
  return (row.messenger_links ?? "").toLowerCase().includes("whatsapp");
}

const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet("Prospects");
sheet.columns = [
  { header: "Компания", key: "name", width: 42 },
  { header: "Категория", key: "category", width: 28 },
  { header: "Город", key: "city", width: 14 },
  { header: "Телефон", key: "phone", width: 22 },
  { header: "WhatsApp", key: "wa", width: 10 },
  { header: "Email", key: "email", width: 28 },
  { header: "Сайт", key: "website", width: 28 },
  { header: "Адрес", key: "address", width: 46 },
  { header: "Статус касания", key: "status", width: 18 },
  { header: "Комментарий", key: "comment", width: 32 }
];

let withPhone = 0;
for (const row of rows) {
  const phone = firstPhone(row);
  if (phone) withPhone++;
  sheet.addRow({
    name: row.company_name ?? "",
    category: row.category ?? "",
    city: row.city ?? "",
    phone,
    wa: hasWhatsApp(row) ? "да" : "",
    email: row.email ?? "",
    website: row.website ?? "",
    address: row.address_clean ?? row.address ?? "",
    status: "",
    comment: ""
  });
}

sheet.getRow(1).font = { bold: true };
sheet.views = [{ state: "frozen", ySplit: 1 }];
sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 10 } };

await wb.xlsx.writeFile("exports/prospects-segment1.xlsx");
console.log(`prospects: ${rows.length} total, ${withPhone} with phone → exports/prospects-segment1.xlsx`);

db.close();
