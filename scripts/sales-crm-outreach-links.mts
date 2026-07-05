import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { cellText } from "../src/bitrix/xlsxRowReader.js";
import {
  buildCrmFirstTouchMessage,
  buildCrmFollowUpMessage,
  buildIntegratorMessage,
  buildWaLink
} from "../src/sales/crmServicesMessages.js";

dotenv.config();

type MessageKind = "first" | "followup" | "integrator";

interface CliArgs {
  inputPath: string | null;
  outPath: string | null;
  message: MessageKind;
}

const MESSAGE_BUILDERS: Record<MessageKind, () => string> = {
  first: buildCrmFirstTouchMessage,
  followup: buildCrmFollowUpMessage,
  integrator: buildIntegratorMessage
};

const COMPANY_HEADERS = ["компания", "название", "company", "company_name"];
const PHONE_HEADERS = ["телефон", "whatsapp", "phone"];

const USAGE = `Usage: tsx scripts/sales-crm-outreach-links.mts --input <prospects.xlsx> [--out <path.xlsx>] [--message first|followup|integrator]

Adds "Сообщение" and "wa.me" columns to a prospects XLSX (needs company and
phone columns; 2GIS export headers are recognized). Nothing is sent anywhere.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { inputPath: null, outPath: null, message: "first" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") args.inputPath = argv[++i] ?? null;
    else if (arg === "--out") args.outPath = argv[++i] ?? null;
    else if (arg === "--message") {
      const kind = argv[++i];
      if (kind !== "first" && kind !== "followup" && kind !== "integrator") {
        throw new Error(`--message must be first|followup|integrator\n\n${USAGE}`);
      }
      args.message = kind;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return args;
}

function findColumn(headerRow: ExcelJS.Row, candidates: string[]): number | null {
  let found: number | null = null;
  headerRow.eachCell((cell, colNumber) => {
    if (found !== null) return;
    const header = cellText(cell).toLowerCase();
    if (candidates.includes(header)) found = colNumber;
  });
  return found;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputPath) throw new Error(`--input is required\n\n${USAGE}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error(`no worksheet found in ${args.inputPath}`);

  const headerRow = worksheet.getRow(1);
  const companyCol = findColumn(headerRow, COMPANY_HEADERS);
  const phoneCol = findColumn(headerRow, PHONE_HEADERS);
  if (!companyCol || !phoneCol) {
    throw new Error(`could not find company/phone columns in row 1 (recognized: ${[...COMPANY_HEADERS, ...PHONE_HEADERS].join(", ")})`);
  }

  const messageCol = worksheet.columnCount + 1;
  const linkCol = worksheet.columnCount + 2;
  worksheet.getRow(1).getCell(messageCol).value = "Сообщение";
  worksheet.getRow(1).getCell(linkCol).value = "wa.me";
  worksheet.getRow(1).getCell(messageCol).font = { bold: true };
  worksheet.getRow(1).getCell(linkCol).font = { bold: true };

  const message = MESSAGE_BUILDERS[args.message]();
  let withLink = 0;
  let withoutPhone = 0;

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const company = cellText(row.getCell(companyCol));
    const phone = cellText(row.getCell(phoneCol));
    if (!company && !phone) return;

    row.getCell(messageCol).value = message;
    const link = buildWaLink(phone, message);
    if (link) {
      row.getCell(linkCol).value = { text: link, hyperlink: link };
      withLink += 1;
    } else {
      row.getCell(linkCol).value = "нет телефона";
      withoutPhone += 1;
    }
  });

  const outPath = args.outPath
    ?? path.join("exports", `${path.basename(args.inputPath, path.extname(args.inputPath))}-outreach.xlsx`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);

  console.log(`message=${args.message} rows_with_link=${withLink} rows_without_phone=${withoutPhone}`);
  console.log(`out=${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
