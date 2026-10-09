import { readManifest } from "../src/automation/core.js";
import { findLatestManifestPath, renderRunSummary } from "../src/automation/runSummary.js";

// Печатает Markdown о самом свежем запуске в каталоге runs (для $GITHUB_STEP_SUMMARY).
// Никогда не падает: сводка — удобство, она не должна менять итог job.
const runsDir = process.argv[2] ?? "runs";
try {
  const manifestPath = findLatestManifestPath(runsDir);
  console.log(manifestPath ? renderRunSummary(readManifest(manifestPath)) : `Запуск в \`${runsDir}\` не найден: манифест не создан.\n`);
} catch (error) {
  console.log(`Сводку запуска собрать не удалось: ${error instanceof Error ? error.message : String(error)}\n`);
}
