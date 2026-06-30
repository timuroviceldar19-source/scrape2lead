import { describe, expect, it } from "vitest";
import { parseFeederConfigPaths, readBatchCsvArg, readCliArg } from "../../src/kz/feederConfig.js";

describe("feederConfig", () => {
  it("parseFeederConfigPaths collects repeated --config flags", () => {
    expect(parseFeederConfigPaths([
      "bins.csv",
      "--config",
      "config.feeder.almaty.json",
      "--skip-2gis",
      "--config",
      "config.feeder.astana.json"
    ])).toEqual([
      "config.feeder.almaty.json",
      "config.feeder.astana.json"
    ]);
  });

  it("parseFeederConfigPaths defaults to config.feeder.json", () => {
    expect(parseFeederConfigPaths(["bins-batch-100.csv"])).toEqual(["config.feeder.json"]);
  });

  it("readBatchCsvArg picks the csv positional argument", () => {
    expect(readBatchCsvArg(["node", "script", "bins-batch-100.csv", "--skip-2gis"])).toBe("bins-batch-100.csv");
  });

  it("readCliArg returns flag values", () => {
    expect(readCliArg(["--out", "exports/foo.xlsx"], "--out")).toBe("exports/foo.xlsx");
  });
});
