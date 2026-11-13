// Раскладывает страницы пульта по вариантам ролей для выкладки на Cloudflare Pages:
// _r/all — полный пульт, _r/m<ID> — вид каждого менеджера из конфига ролей.
// Почты не печатает: лог workflow публичный.
//
//   npx tsx scripts/pult-variants.mts exports/sales-pult exports/sales-pult-deploy exports/pult-gate/config.json

import fs from "node:fs";
import path from "node:path";
import type { PultGateConfig } from "../src/bitrix/salesPult/gate/config.js";
import { buildManagerVariant, renderManagerVariant } from "../src/bitrix/salesPult/variants/manager.js";
import type { SalesPultPayload } from "../src/bitrix/salesPult/types.js";
import type { RegisterPagePayload } from "../src/bitrix/salesPult/site.js";
import type { NormalizedPlanDeal } from "../src/bitrix/salesPult/plans/types.js";

const [srcDir = "exports/sales-pult", outDir = "exports/sales-pult-deploy", configPath = "exports/pult-gate/config.json"] = process.argv.slice(2);

const readJson = <T>(file: string): T | null => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as T : null);
const write = (variant: string, name: string, html: string) => {
  const dir = path.join(outDir, "_r", variant);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), html, "utf8");
};

fs.rmSync(outDir, { recursive: true, force: true });
write("all", "index.html", fs.readFileSync(path.join(srcDir, "index.html"), "utf8"));
write("all", "reg.html", fs.readFileSync(path.join(srcDir, "reg.html"), "utf8"));
const built = ["all"];

const config = readJson<PultGateConfig | null>(configPath);
if (config) {
  const roles = Object.values(config.users);
  const managerIds = [...new Set(roles.flatMap((r) => (r.kind === "manager" ? [r.managerId] : [])))];
  if (managerIds.length) {
    const pult = readJson<SalesPultPayload>(path.join(srcDir, "payload.json"));
    const reg = readJson<RegisterPagePayload>(path.join(srcDir, "payload-reg.json"));
    if (!pult || !reg) {
      console.error("::error::[Роли] нет payload.json или payload-reg.json: виды менеджеров не собрать");
      process.exit(1);
    }
    const planDeals = readJson<NormalizedPlanDeal[]>(path.join(srcDir, "plan-deals.json"));
    const salesConfig = readJson<{ register?: { managerAliases?: Record<string, string> } }>("config/sales-pult.json");
    for (const managerId of managerIds) {
      const variant = buildManagerVariant({ pult, reg, planDeals, managerId, aliases: salesConfig?.register?.managerAliases });
      if (!variant) {
        console.warn(`::warning::[Роли] сотрудника с ID ${managerId} нет в пульте — его вид не собран, он увидит «ещё не готов»`);
        continue;
      }
      const pages = renderManagerVariant(variant);
      write(`m${managerId}`, "index.html", pages.index);
      write(`m${managerId}`, "reg.html", pages.reg);
      built.push(`m${managerId}`);
    }
  }
  if (roles.some((r) => r.kind === "tv")) {
    console.warn("::warning::[Роли] вид телевизора ещё не собирается — роль tv увидит «ещё не готов»");
  }
}
console.log(`[Роли] варианты страниц: ${built.join(", ")}`);
