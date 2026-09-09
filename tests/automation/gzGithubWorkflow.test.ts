import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowsDir = path.resolve(".github/workflows");

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}

describe("GZ GitHub workflow credentials", () => {
  it("passes the Goszakup token into the reusable automation", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toMatch(/secrets:\s+[\s\S]*GOSZAKUP_TOKEN:\s+required: true/);
    expect(reusable).toContain("GOSZAKUP_TOKEN: ${{ secrets.GOSZAKUP_TOKEN }}");
  });

  it.each(["gz-daily-main.yml", "gz-daily-pk.yml"])(
    "%s forwards the Goszakup token",
    (workflowName) => {
      expect(readWorkflow(workflowName)).toContain(
        "GOSZAKUP_TOKEN: ${{ secrets.GOSZAKUP_TOKEN }}"
      );
    }
  );
});

describe("GZ GitHub workflow browser setup", () => {
  it("installs the Playwright browser without refreshing external apt repositories", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toContain("npx playwright install chromium");
    expect(reusable).not.toContain("playwright install --with-deps");
  });
});
