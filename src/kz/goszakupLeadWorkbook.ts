import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { GoszakupLeadCandidate } from "./goszakupLeads.js";

const columns: Array<Partial<ExcelJS.Column>> = [
  { header: "БИН", key: "bin", width: 16 },
  { header: "Название", key: "name", width: 42 },
  { header: "Телефон", key: "phone", width: 17 },
  { header: "phone_ok", key: "phoneOk", width: 11 },
  { header: "Город", key: "city", width: 16 },
  { header: "Сектор", key: "economicSector", width: 22 },
  { header: "oked_list", key: "okedList", width: 22 },
  { header: "Контрактов за квартал", key: "currentContracts", width: 20 },
  { header: "Сумма за квартал", key: "currentAmount", width: 18 },
  { header: "Дата последнего контракта", key: "lastSignedAt", width: 24 },
  { header: "Номер последнего контракта", key: "lastContractNumber", width: 28 },
  { header: "Заказчик последнего контракта", key: "lastCustomerName", width: 42 },
  { header: "БИН заказчика", key: "lastCustomerBin", width: 16 },
  { header: "Ссылка на реестр", key: "registryUrl", width: 45 },
  { header: "Статус звонка", key: "callStatus", width: 20 },
  { header: "Дата следующего контакта", key: "nextContactAt", width: 26 },
  { header: "Заметка", key: "note", width: 35 }
];

export async function writeGoszakupLeadWorkbook(options: {
  outPath: string;
  callLeads: GoszakupLeadCandidate[];
  otherCityLeads: GoszakupLeadCandidate[];
  withoutPhoneLeads: GoszakupLeadCandidate[];
}): Promise<void> {
  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, "Лиды", options.callLeads);
  addSheet(workbook, "Другие города", options.otherCityLeads);
  addSheet(workbook, "Без телефона", options.withoutPhoneLeads);
  await workbook.xlsx.writeFile(options.outPath);
}

function addSheet(workbook: ExcelJS.Workbook, name: string, leads: GoszakupLeadCandidate[]): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: "A1", to: "Q1" };
  sheet.getColumn("bin").numFmt = "@";
  sheet.getColumn("lastCustomerBin").numFmt = "@";
  sheet.getColumn("currentAmount").numFmt = "#,##0.00";
  for (const lead of leads) {
    const row = sheet.addRow({ ...lead, callStatus: "", nextContactAt: "", note: "" });
    const linkCell = row.getCell("registryUrl");
    if (lead.registryUrl) {
      linkCell.value = { text: lead.registryUrl, hyperlink: lead.registryUrl };
      linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
  }
}
