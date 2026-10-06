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

describe("GZ deal outcome check", () => {
  it("runs after the PK collection even when the collection failed", () => {
    const pk = readWorkflow("gz-daily-pk.yml");
    const job = pk.slice(pk.indexOf("  deal-outcomes:"));

    expect(job).toContain("needs: [guard, pk-plans]");
    expect(job).toContain("if: always() && needs.guard.outputs.should-run == 'true'");
    // A failed check must not fail the run: the backstop and the watchdog read run conclusions.
    expect(job).toContain("continue-on-error: true");
    expect(job).toContain("npx tsx scripts/check-gz-deal-outcomes.mts --execute");
    expect(job).toContain("BITRIX24_WEBHOOK_URL: ${{ secrets.BITRIX24_WEBHOOK_URL }}");
    expect(job).toContain("GOSZAKUP_TOKEN: ${{ secrets.GOSZAKUP_TOKEN }}");
  });
});

describe("GZ GitHub workflow browser setup", () => {
  it("installs the Playwright browser without refreshing external apt repositories", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toContain("npx playwright install chromium");
    expect(reusable).not.toContain("playwright install --with-deps");
  });
});
