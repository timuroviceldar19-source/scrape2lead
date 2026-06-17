import ExcelJS from "exceljs";

const SRC = "exports/kz-top-a-sales.xlsx";
const OUT = "exports/kz-top-a-sample-3.xlsx";

const NAVY = "FF1F4E79";
const LIGHT = "FFDCE6F1";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const src = wb.getWorksheet("Sales Top-A");
if (!src) throw new Error("Sales Top-A sheet not found");

// Source columns: 1 rank, 2 bin, 3 name, 4 priority, 5 active count,
// 6 active budget, 7 total count, 8 registry phone, 11 director, 13 gis phone
interface SampleRow {
  name: string;
  bin: string;
  active: number;
  budget: number;
  phone: string;
  director: string;
}

const rows: SampleRow[] = [];
for (let r = 2; r <= src.rowCount && rows.length < 3; r++) {
  const row = src.getRow(r);
  const phone = String(row.getCell(8).value ?? "").trim() || String(row.getCell(13).value ?? "").trim();
  if (!phone) continue;
  rows.push({
    name: String(row.getCell(3).value ?? ""),
    bin: String(row.getCell(2).value ?? ""),
    active: Number(row.getCell(5).value ?? 0),
    budget: Number(row.getCell(6).value ?? 0),
    phone,
    director: String(row.getCell(11).value ?? "")
  });
}

const out = new ExcelJS.Workbook();
out.creator = "KZ Company Intelligence";
const sheet = out.addWorksheet("3 из 30", {
  views: [{ showGridLines: false }]
});

sheet.columns = [
  { width: 3 },
  { width: 46 },
  { width: 17 },
  { width: 14 },
  { width: 22 },
  { width: 20 },
  { width: 30 }
];

// Title
sheet.mergeCells("B2:G2");
const title = sheet.getCell("B2");
title.value = "Строительные компании с активными госконтрактами";
title.font = { bold: true, size: 16, color: { argb: NAVY } };

sheet.mergeCells("B3:G3");
const subtitle = sheet.getCell("B3");
subtitle.value = "Пример: 3 компании из 30 · данные goszakup.gov.kz + stat.gov.kz · июнь 2026";
subtitle.font = { size: 11, color: { argb: "FF666666" } };

// Header
const headerRow = sheet.getRow(5);
const headers = ["Компания", "БИН", "Активных контрактов", "Сумма активных, ₸", "Телефон", "Директор"];
headers.forEach((h, i) => {
  const cell = headerRow.getCell(i + 2);
  cell.value = h;
  cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  cell.border = { bottom: { style: "thin", color: { argb: NAVY } } };
});
headerRow.height = 28;

// Data rows
rows.forEach((data, i) => {
  const row = sheet.getRow(6 + i);
  row.height = 24;
  const values = [data.name, data.bin, data.active, data.budget, data.phone, data.director];
  values.forEach((v, j) => {
    const cell = row.getCell(j + 2);
    cell.value = v;
    cell.alignment = { vertical: "middle", wrapText: j === 0 };
    if (i % 2 === 0) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    }
    cell.border = { bottom: { style: "hair", color: { argb: "FFB0C4DE" } } };
  });
  row.getCell(5).numFmt = "#,##0";
  row.getCell(4).alignment = { horizontal: "center", vertical: "middle" };
});

// CTA block
const ctaTop = 6 + rows.length + 1;
sheet.mergeCells(`B${ctaTop}:G${ctaTop}`);
const cta = sheet.getCell(`B${ctaTop}`);
cta.value = "Полная версия: 30 компаний · 26 прямых телефонов · директора · суммы и количество контрактов";
cta.font = { bold: true, size: 12, color: { argb: NAVY } };

sheet.mergeCells(`B${ctaTop + 1}:G${ctaTop + 1}`);
const cta2 = sheet.getCell(`B${ctaTop + 1}`);
cta2.value = "Стоимость: 50 000 ₸ · обновление данных — на дату покупки";
cta2.font = { size: 11, color: { argb: "FF666666" } };

await out.xlsx.writeFile(OUT);
console.log(`sample saved: ${OUT} (${rows.length} rows)`);
