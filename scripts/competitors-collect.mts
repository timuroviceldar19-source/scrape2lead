import fs from "node:fs";
import path from "node:path";
import { backfillCompetitors } from "../src/kz/competitors/collector.js";
import { loadCompetitorsView, updateCompetitorsWindow } from "../src/kz/competitors/load.js";
import { renderPultHtml } from "../src/bitrix/salesPult/site.js";
import type { SalesPultPayload } from "../src/bitrix/salesPult/types.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const fromDate = arg("--from") || "2026-01-01";
  const toDate = arg("--to") || "2026-11-15";
  const dbPath = arg("--db") || undefined;
  const incremental = has("--incremental");
  const renderLocal = has("--render-local");
  const skipDiscover = has("--skip-discover");
  const maxMinutes = arg("--max-minutes") ? Number(arg("--max-minutes")) : undefined;

  const t0 = performance.now();
  let blockedRender = false;
  if (incremental) {
    const res = await updateCompetitorsWindow({
      todayAlmaty: toDate,
      dbPath,
      strict: true
    });
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[Competitors] Incremental update finished in ${sec}s: ${JSON.stringify(res)}`);
  } else {
    const res = await backfillCompetitors({
      fromDate,
      toDate,
      dbPath,
      skipDiscover,
      maxDurationMs: maxMinutes ? maxMinutes * 60 * 1000 : undefined,
      onProgress: (stage, detail) => {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(`[Competitors][${elapsed}s] ${stage}: ${detail}`);
      }
    });
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[Competitors] Full collection finished in ${sec}s: ${JSON.stringify({
      lotsCount: res.lotsCount,
      bidsCount: res.bidsCount,
      specsCount: res.specsCount,
      discoveredCount: res.discoveredCount,
      refreshedAnnos: res.refreshedAnnos,
      remainingMissingDetails: res.remainingMissingDetails,
      incomplete: res.incomplete,
      errors: res.errors.length
    })}`);
    if (res.errors.length) {
      console.log("[Competitors] First 10 errors:");
      for (const e of res.errors.slice(0, 10)) console.log(" -", e);
    }
    if (res.incomplete || res.remainingMissingDetails > 0) {
      console.error(`сбор неполный: осталось ${res.remainingMissingDetails} карточек (${res.stopReason || "ошибки при сборе"}), перезапустите позже`);
      process.exitCode = 1;
      blockedRender = true;
    }
  }

  const view = loadCompetitorsView({ todayAlmaty: toDate, dbPath });
  console.log("[Competitors] Summary:", JSON.stringify({
    updatedAt: view.updatedAt,
    ip: view.ip?.summary ?? null,
    kt: view.kt?.summary ?? null,
    ipTemplates: (view.ip?.specTemplates ?? []).map((t) => ({ id: t.templateId, total: t.totalLots, strong: t.strongLots, partial: t.partialLots })),
    ktTemplates: (view.kt?.specTemplates ?? []).map((t) => ({ id: t.templateId, total: t.totalLots, strong: t.strongLots, partial: t.partialLots }))
  }, null, 2));

  if (renderLocal && !blockedRender) {
    const fixture = JSON.parse(fs.readFileSync(path.resolve("tests/fixtures/sales-pult/midday.json"), "utf8")) as SalesPultPayload;
    fixture.asOfDate = toDate;
    fixture.competitors = view;
    const html = renderPultHtml(fixture);
    const outDir = path.resolve("exports/sales-pult");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
    console.log(`[Competitors] Rendered ${path.join(outDir, "index.html")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
