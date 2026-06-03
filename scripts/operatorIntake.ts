import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const REAL_SAMPLE_PATH = "exports/autoservice-radar-astana-real-sample-50.xlsx";

// Regex patterns for extraction
const PHONE_REGEX = /(?:\+7|8)\s*\(?\d{3}\)?\s*\d{3}[-\s]?\d{2}[-\s]?\d{2}/g;
const WA_REGEX = /(?:wa\.me|whatsapp\.com)\/(?:chat\/)?(\d+)/gi;
const TG_REGEX = /t\.me\/([a-zA-Z0-9_]+)/gi;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^8/, "7");
}

function parseText(text: string) {
  const phones = [...new Set((text.match(PHONE_REGEX) || []).map(normalizePhone))];
  const waMatches = [...new Set(Array.from(text.matchAll(WA_REGEX)).map(m => `+${m[1]}`))];
  const tgMatches = [...new Set(Array.from(text.matchAll(TG_REGEX)).map(m => `@${m[1]}`))];
  const emails = [...new Set(text.match(EMAIL_REGEX) || [])];
  const urls = [...new Set(text.match(URL_REGEX) || [])];

  const websites = urls.filter(u => !u.includes("wa.me") && !u.includes("whatsapp") && !u.includes("t.me") && !u.includes("mailto:"));

  // Try to find a phone in WA matches that isn't in the main phones list
  const waPhones = waMatches.filter(p => !phones.includes(normalizePhone(p)));

  return {
    phones: [...phones, ...waPhones],
    telegram: tgMatches,
    emails,
    websites
  };
}

function calculateCompleteness(data: any): number {
  let score = 0;
  if (data.phone) score += 40;
  if (data.whatsapp) score += 20;
  if (data.address) score += 20;
  if (data.source_url) score += 10;
  if (data.website || data.email) score += 10;
  return score;
}

async function checkDuplicates(workbook: ExcelJS.Workbook, newData: any): Promise<boolean> {
  const sheet = workbook.worksheets[0];
  if (!sheet) return false;

  const newPhoneNorm = newData.phone ? normalizePhone(newData.phone) : null;
  const newNameNorm = newData.company_name ? newData.company_name.toLowerCase().trim() : "";
  const newSourceNorm = newData.source_url ? newData.source_url.toLowerCase().trim() : "";

  // Get headers to find column indices
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = String(cell.value || "").toLowerCase().trim();
  });

  const phoneCol = headers.findIndex(h => h.includes("телефон") || h === "phone");
  const nameCol = headers.findIndex(h => h.includes("компания") || h === "company_name");
  const sourceCol = headers.findIndex(h => h.includes("источник") || h === "source_url");

  let isDuplicate = false;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    
    const rowPhone = phoneCol > 0 ? String(row.getCell(phoneCol).value || "").trim() : "";
    const rowName = nameCol > 0 ? String(row.getCell(nameCol).value || "").toLowerCase().trim() : "";
    const rowSource = sourceCol > 0 ? String(row.getCell(sourceCol).value || "").toLowerCase().trim() : "";

    const rowPhoneNorm = normalizePhone(rowPhone);

    if (newPhoneNorm && rowPhoneNorm && newPhoneNorm === rowPhoneNorm) {
      isDuplicate = true;
    }
    if (newPhoneNorm && rowPhoneNorm && newNameNorm && rowName && newPhoneNorm === rowPhoneNorm && newNameNorm === rowName) {
      isDuplicate = true;
    }
    if (newSourceNorm && rowSource && newSourceNorm === rowSource) {
      isDuplicate = true;
    }
  });

  return isDuplicate;
}

async function appendToRealSample(data: any) {
  if (!fs.existsSync(REAL_SAMPLE_PATH)) {
    console.error(`❌ Real Sample file not found at ${REAL_SAMPLE_PATH}`);
    process.exit(1);
  }

  const completeness = calculateCompleteness(data);
  if (completeness < 40) {
    console.error(`❌ Completeness score too low: ${completeness}. Minimum required is 40.`);
    console.error("Ensure at least phone and source_url are provided.");
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(REAL_SAMPLE_PATH);

  const isDuplicate = await checkDuplicates(workbook, data);
  if (isDuplicate) {
    console.error("❌ Duplicate detected based on phone, name+phone, or source_url.");
    process.exit(1);
  }

  // Create backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = REAL_SAMPLE_PATH.replace(".xlsx", `.backup-${timestamp}.xlsx`);
  fs.copyFileSync(REAL_SAMPLE_PATH, backupPath);
  console.log(`💾 Backup created: ${backupPath}`);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    console.error("❌ Could not find worksheet in Real Sample.");
    process.exit(1);
  }

  // Map data to sheet columns (assuming standard Russian headers from Real Sample 50)
  const row = sheet.addRow({
    "Компания": data.company_name || "",
    "Категория": data.category || "",
    "Город": data.city || "Астана",
    "Адрес": data.address || "",
    "Телефон": data.phone || "",
    "WhatsApp": data.whatsapp || "",
    "Telegram": data.telegram || "",
    "Сайт": data.website || "",
    "Email": data.email || "",
    "Источник": data.source_url || "",
    "Дата проверки": data.checked_at || new Date().toISOString().split("T")[0],
    "Полнота данных": completeness,
    "Готов к рассылке": completeness >= 80 && data.phone ? "Да" : "Нет",
    "Статус проверки": completeness >= 80 ? "Проверено" : "Требует проверки",
    "Заметки": data.notes || ""
  });

  await workbook.xlsx.writeFile(REAL_SAMPLE_PATH);
  console.log(`✅ Successfully appended to ${REAL_SAMPLE_PATH}`);
  console.log(`📊 Completeness Score: ${completeness}`);
  console.log(`📊 Verification Status: ${completeness >= 80 ? "Проверено" : "Требует проверки"}`);
  console.log(`📊 Ready for Outreach: ${completeness >= 80 && data.phone ? "Да" : "Нет"}`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes("--parse-text")) {
    const textIndex = args.indexOf("--parse-text") + 1;
    if (!args[textIndex]) {
      console.error("❌ Please provide a file path or text after --parse-text");
      process.exit(1);
    }
    
    let text = "";
    if (fs.existsSync(args[textIndex])) {
      text = fs.readFileSync(args[textIndex], "utf-8");
    } else {
      text = args[textIndex];
    }
    
    const parsed = parseText(text);
    console.log(JSON.stringify(parsed, null, 2));
  } else if (args.includes("--append")) {
    const jsonIndex = args.indexOf("--append") + 1;
    if (!args[jsonIndex]) {
      console.error("❌ Please provide a JSON string or file path after --append");
      process.exit(1);
    }
    
    let jsonData: any = {};
    if (fs.existsSync(args[jsonIndex])) {
      jsonData = JSON.parse(fs.readFileSync(args[jsonIndex], "utf-8"));
    } else {
      jsonData = JSON.parse(args[jsonIndex]);
    }
    
    await appendToRealSample(jsonData);
  } else {
    console.log("🛠️ Operator Intake Tool for AutoService Radar KZ");
    console.log("\nUsage:");
    console.log("  npm run operator:intake -- --parse-text \"raw text or file.txt\"");
    console.log("  npm run operator:intake -- --append '{\"company_name\": \"...\", \"phone\": \"...\", \"source_url\": \"...\"}'");
    console.log("\nSee docs/operator-intake.md for detailed instructions.");
  }
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
