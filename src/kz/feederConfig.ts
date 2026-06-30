export function parseFeederConfigPaths(argv: string[]): string[] {
  const configs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) {
      configs.push(argv[i + 1]);
      i++;
    }
  }
  return configs.length > 0 ? configs : ["config.feeder.json"];
}

export function readCliArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function readBatchCsvArg(argv: string[]): string {
  return argv.find((arg) => !arg.startsWith("-") && arg.endsWith(".csv")) ?? "bins-batch-100.csv";
}
