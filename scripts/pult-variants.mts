// Раскладывает страницы пульта по вариантам ролей для выкладки на Cloudflare Pages:
// _r/all — полный пульт (с «Финансами»), _r/rop — вид РОП (без «Финансов»),
// _r/rto — вид РТО (без «Финансов» и «Выручки»),
// _r/m<ID> — вид каждого менеджера из конфига ролей (без «Финансов» и «Конкурентов»).
// Почты не печатает: лог workflow публичный.
//
//   npx tsx scripts/pult-variants.mts exports/sales-pult exports/sales-pult-deploy exports/pult-gate/config.json

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PultGateConfig } from "../src/bitrix/salesPult/gate/config.js";
import { buildManagerVariant, renderManagerVariant } from "../src/bitrix/salesPult/variants/manager.js";
import { buildRopVariant, renderRopVariant } from "../src/bitrix/salesPult/variants/rop.js";
import { buildRtoVariant, renderRtoVariant } from "../src/bitrix/salesPult/variants/rto.js";
import type { SalesPultPayload } from "../src/bitrix/salesPult/types.js";
import type { RegisterPagePayload } from "../src/bitrix/salesPult/site.js";
import type { NormalizedPlanDeal } from "../src/bitrix/salesPult/plans/types.js";
import { parsePayloadStock } from "../src/bitrix/salesPult/stock/availability.js";

function readJson<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
}

function copyMarketFiles(srcMarketDir: string, destMarketDir: string): number {
  if (!fs.existsSync(srcMarketDir)) return 0;
  let copied = 0;
  for (const group of ["ip", "kt"] as const) {
    const groupSrc = path.join(srcMarketDir, group);
    if (!fs.existsSync(groupSrc)) continue;
    const groupDest = path.join(destMarketDir, group);
    fs.mkdirSync(groupDest, { recursive: true });
    for (const entry of fs.readdirSync(groupSrc, { withFileTypes: true })) {
      if (entry.isFile() && /^\d{4}-(0[1-9]|1[0-2])\.json$/.test(entry.name)) {
        fs.copyFileSync(path.join(groupSrc, entry.name), path.join(groupDest, entry.name));
        copied++;
      }
    }
  }
  return copied;
}

export function deployPultVariants(
  srcDir = "exports/sales-pult",
  outDir = "exports/sales-pult-deploy",
  configPath = "exports/pult-gate/config.json"
): string[] {
  const write = (variant: string, name: string, html: string) => {
    const dir = path.join(outDir, "_r", variant);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), html, "utf8");
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  write("all", "index.html", fs.readFileSync(path.join(srcDir, "index.html"), "utf8"));
  write("all", "reg.html", fs.readFileSync(path.join(srcDir, "reg.html"), "utf8"));
  // «Финансы» и «Фин. отчёты» — только полный вариант: РОП, РТО, менеджеру и ТВ их не собираем.
  if (fs.existsSync(path.join(srcDir, "fin.html"))) write("all", "fin.html", fs.readFileSync(path.join(srcDir, "fin.html"), "utf8"));
  if (fs.existsSync(path.join(srcDir, "fin-reports.html"))) {
    write("all", "fin-reports.html", fs.readFileSync(path.join(srcDir, "fin-reports.html"), "utf8"));
  }
  const marketSrcDir = path.join(srcDir, "market");
  copyMarketFiles(marketSrcDir, path.join(outDir, "_r", "all", "market"));
  const built = ["all"];

  const config = readJson<PultGateConfig | null>(configPath);
  if (config) {
    const roles = Object.values(config.users);
    const hasRop = roles.some((r) => r.kind === "rop");
    const hasRto = roles.some((r) => r.kind === "rto");
    const managerIds = [...new Set(roles.flatMap((r) => (r.kind === "manager" ? [r.managerId] : [])))];
    if (hasRop || hasRto || managerIds.length) {
      const pult = readJson<SalesPultPayload>(path.join(srcDir, "payload.json"));
      const needReg = hasRop || managerIds.length > 0;
      const reg = needReg ? readJson<RegisterPagePayload>(path.join(srcDir, "payload-reg.json")) : null;
      if (!pult || (needReg && !reg)) {
        console.error("::error::[Роли] нет payload.json или payload-reg.json: варианты ролей не собрать");
        process.exit(1);
      }
      // Склад читается из JSON: неверный формат (или лишние поля — суммы, компании) ролям без «Финансов» не отдаём.
      const stock = parsePayloadStock(pult.stock);
      if (stock.ok) pult.stock = stock.stock;
      else {
        delete pult.stock;
        console.warn(`::warning::[Склад] payload.stock не прошёл проверку (ошибок: ${stock.issues}) — склад в видах ролей не показан`);
      }
      if (hasRop && reg) {
        const ropPages = renderRopVariant(buildRopVariant({ pult, reg }));
        write("rop", "index.html", ropPages.index);
        write("rop", "reg.html", ropPages.reg);
        copyMarketFiles(marketSrcDir, path.join(outDir, "_r", "rop", "market"));
        built.push("rop");
      }
      if (hasRto) {
        const rtoPages = renderRtoVariant(buildRtoVariant({ pult }));
        write("rto", "index.html", rtoPages.index);
        copyMarketFiles(marketSrcDir, path.join(outDir, "_r", "rto", "market"));
        built.push("rto");
      }
      if (managerIds.length && reg) {
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
          copyMarketFiles(marketSrcDir, path.join(outDir, "_r", `m${managerId}`, "market"));
          built.push(`m${managerId}`);
        }
      }
    }
    if (roles.some((r) => r.kind === "tv")) {
      console.warn("::warning::[Роли] вид телевизора ещё не собирается — роль tv увидит «ещё не готов»");
    }
  }
  console.log(`[Роли] варианты страниц: ${built.join(", ")}`);
  return built;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [srcDir, outDir, configPath] = process.argv.slice(2);
  deployPultVariants(srcDir, outDir, configPath);
}
