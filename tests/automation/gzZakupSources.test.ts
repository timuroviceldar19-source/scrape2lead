import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("утренние команды без обязательного токена ows", () => {
  for (const file of ["scripts/check-gz-deal-outcomes.mts"]) {
    it(`${file}: GOSZAKUP_TOKEN только для резерва`, () => {
      expect(fs.readFileSync(file, "utf8")).not.toMatch(/if\s*\(![\w.]*token\)\s*throw new Error\("GOSZAKUP_TOKEN is required"\)/);
    });
  }
});
