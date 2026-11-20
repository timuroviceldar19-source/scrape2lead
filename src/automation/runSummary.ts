import fs from "node:fs";
import path from "node:path";
import type { AutomationManifest, AutomationStage, StageStatus } from "./types.js";

const APPLY_STAGES = ["applyPlans", "applyLots"] as const;
const ERROR_LIMIT = 300;

const STATUS_ICON: Record<StageStatus, string> = { succeeded: "✅", failed: "❌", running: "⏳" };

/** Самый свежий запуск в `runsDir`: id вида `YYYYMMDD-HHMMSS` сортируется как строка. */
export function findLatestManifestPath(runsDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(runsDir, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort();
  const latest = names.at(-1);
  return latest ? path.join(runsDir, latest, "manifest.json") : null;
}

/** Markdown для GitHub Step Summary: что запуск сделал и сколько сделок это дало. */
export function renderRunSummary(manifest: AutomationManifest): string {
  const failed = manifest.status === "failed" || Object.values(manifest.stages).some((stage) => stage.status === "failed");
  const skipped = Object.values(manifest.stages).flatMap(stage => stage.skipped ?? []);
  const icon = manifest.status === "failed" ? "❌" : skipped.length || failed ? "⚠️" : "✅";
  const lines = [
    `### ${icon} Запуск ${manifest.runId}: ${manifest.status}`,
    "",
    `Конфиг \`${manifest.config.path}\`, workflow \`${manifest.workflow ?? "plans-and-lots"}\``,
    "",
    dealsLine(manifest),
    "",
    "| Этап | Статус | Время | Показатели |",
    "| --- | --- | --- | --- |"
  ];
  for (const [name, stage] of Object.entries(manifest.stages)) {
    lines.push(`| ${name} | ${STATUS_ICON[stage.status]} | ${duration(stage)} | ${stageDetails(stage)} |`);
  }
  for (const [name, stage] of Object.entries(manifest.stages)) {
    if (stage.sourceUnreachable) lines.push("", `**Источник полностью недоступен: ${name}**`, "");
  }
  if (skipped.length) {
    lines.push("", `**⚠️ Частичный сбор: пропущено запросов — ${skipped.length}**`, "",
      "| Этап | Запрос | Период | Страница | Сохранено строк | Попыток | Причина |",
      "| --- | --- | --- | --- | --- | --- | --- |");
    for (const query of skipped) {
      const page = query.failedPage === null ? "—" : query.totalPages && query.totalPages > query.failedPage
        ? `${query.failedPage}–${query.totalPages}` : query.totalPages === null ? `${query.failedPage} и далее` : String(query.failedPage);
      const reason = query.reason + (query.planPointIds?.length ? `; пункты: ${query.planPointIds.join(", ")}` : "");
      lines.push(`| ${[query.stage, query.query, `${query.year}: ${query.months.join(", ")}`, page,
        String(query.keptRows), String(query.attempts), reason].map(cell).join(" | ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function dealsLine(manifest: AutomationManifest): string {
  const applied = APPLY_STAGES.flatMap((name) => {
    const stage = manifest.stages[name];
    return stage?.status === "succeeded" ? [stage.counts ?? {}] : [];
  });
  if (applied.length === 0) return "**Сделки:** запись в Bitrix не выполнялась";

  const total = (key: string) => applied.reduce((sum, counts) => sum + (counts[key] ?? 0), 0);
  const parts = [
    `создано ${total("create")}`,
    `обновлено ${total("update")}`,
    `пересмотрено ${total("revise")}`,
    `уже были ${total("existing")}`,
    `дубликаты ${total("duplicate")}`,
    `не заведено по количеству ${total("filtered")}`
  ];
  return `**Сделки:** ${parts.join(", ")}`;
}

function duration(stage: AutomationStage): string {
  if (!stage.finishedAt) return "—";
  const seconds = Math.max(0, Math.round((Date.parse(stage.finishedAt) - Date.parse(stage.startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}м ${rest}с` : `${rest}с`;
}

function stageDetails(stage: AutomationStage): string {
  const counts = Object.entries(stage.counts ?? {}).map(([key, value]) => `${key}=${value}`);
  const parts = [...counts];
  if (stage.status === "succeeded" && stage.counts?.rows === 0 && (stage.counts.successful_queries ?? 0) > 0
    && (stage.counts.fetch_failed ?? 0) === 0 && !stage.skipped?.length) {
    parts.push("Найдено 0, сбоев нет");
  }
  if (stage.error) parts.push(shorten(stage.error));
  return cell(parts.join(" ")) || "—";
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_LIMIT ? `${flat.slice(0, ERROR_LIMIT)}…` : flat;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
