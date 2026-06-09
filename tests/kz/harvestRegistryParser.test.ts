import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateHarvestCandidate } from "../../src/kz/binValidation.js";
import { parseRegistrySearchRows } from "../../src/kz/harvestRegistryParser.js";

const FIXTURES = path.resolve("tests/fixtures");

describe("parseRegistrySearchRows", () => {
  it("parses mixed search table rows", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-search-too-mixed.html"), "utf8");
    const rows = parseRegistrySearchRows(html);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ bin: "061040006408", participant_id: "44899" });
  });

  it("filters to validated ТОО only", () => {
    const html = fs.readFileSync(path.join(FIXTURES, "goszakup-registry-search-too-mixed.html"), "utf8");
    const accepted = parseRegistrySearchRows(html).filter((row) => validateHarvestCandidate(row).accepted);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.bin).toBe("061040006408");
  });
});
