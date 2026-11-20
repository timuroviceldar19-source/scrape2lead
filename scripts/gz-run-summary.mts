import fs from "node:fs";
import { readManifest } from "../src/automation/core.js";
import { findLatestManifestPath, renderRunSummary } from "../src/automation/runSummary.js";

// Печатает Markdown о самом свежем запуске в каталоге runs (для $GITHUB_STEP_SUMMARY).
// Никогда не падает: сводка — удобство, она не должна менять итог job.
const runsDir = process.argv[2] ?? "runs";
try {
  const logPath = process.argv[3];
  const stateKey = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}${process.env.GZ_PORTAL_MACHINE ? `:${process.env.GZ_PORTAL_MACHINE}` : ""}`;
  const state = logPath && fs.existsSync(`${logPath}.portal-probe-state`)
    && fs.readFileSync(`${logPath}.portal-probe-state`, "utf8").trim();
  if (state === `${stateKey}:handoff`) {
    console.log("↪ портал недоступен с этой машины GitHub, сбор передан следующей машине.\n");
  } else if (state === `${stateKey}:blocked`) {
    console.log("❌ портал недоступен с этой машины GitHub, прогон не начинался.\n");
  } else {
    const manifestPath = findLatestManifestPath(runsDir);
    console.log(manifestPath ? renderRunSummary(readManifest(manifestPath)) : `Запуск в \`${runsDir}\` не найден: манифест не создан.\n`);
  }
} catch (error) {
  console.log(`Сводку запуска собрать не удалось: ${error instanceof Error ? error.message : String(error)}\n`);
}
