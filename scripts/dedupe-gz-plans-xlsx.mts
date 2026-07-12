import { dedupeGzPlansXlsx } from "../src/kz/gzPlanXlsxDedupe.js";

interface CliArgs {
  inputPath: string;
  outputPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputPath: "exports/gz-plans-latest.xlsx",
    outputPath: "exports/gz-plans-deduped.xlsx"
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      args.inputPath = argv[++i] ?? args.inputPath;
    } else if (arg === "--out") {
      args.outputPath = argv[++i] ?? args.outputPath;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await dedupeGzPlansXlsx(args.inputPath, args.outputPath);

  console.log(`gz-plans dedupe: ${result.outputPath}`);
  console.log(
    `original=${result.originalRows} removed=${result.removedRows} final=${result.finalRows} unique_plan_ids=${result.uniquePlanPointIds}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
