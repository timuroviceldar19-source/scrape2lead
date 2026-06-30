import dotenv from "dotenv";
import { readBinsFromCsv } from "../src/kz/csv.js";
import { exportKzReport } from "../src/kz/kzExporter.js";

dotenv.config();

interface Args {
  binsFile: string | null;
  outPath: string | null;
  format: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { binsFile: null, outPath: null, format: "xlsx" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bins") {
      args.binsFile = argv[++i] ?? null;
    } else if (arg === "--out") {
      args.outPath = argv[++i] ?? null;
    } else if (arg === "--format") {
      args.format = argv[++i] ?? "xlsx";
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.format !== "xlsx") {
    throw new Error("Only --format xlsx is supported for KZ export");
  }

  const result = await exportKzReport({
    bins: args.binsFile ? readBinsFromCsv(args.binsFile) : undefined,
    outPath: args.outPath ?? undefined
  });

  console.log(`kz export: ${result.xlsxPath}`);
  console.log(`companies=${result.companies} tenders=${result.tenders} errors=${result.errors}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
