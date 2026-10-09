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
    // dispatch: only when the Worker (or a person) asks for it; schedule backstop keeps it.
    expect(job).toContain("github.event_name != 'workflow_dispatch' || inputs.deal_outcomes");
    // A failed check must not fail the run: the backstop and the watchdog read run conclusions.
    expect(job).toContain("continue-on-error: true");
    expect(job).toContain("npx tsx scripts/check-gz-deal-outcomes.mts --execute");
    expect(job).toContain("BITRIX24_WEBHOOK_URL: ${{ secrets.BITRIX24_WEBHOOK_URL }}");
    expect(job).toContain("GOSZAKUP_TOKEN: ${{ secrets.GOSZAKUP_TOKEN }}");
  });
});

describe("GZ deal outcome dispatch input", () => {
  it("declares a boolean deal_outcomes input that defaults to true for manual runs", () => {
    const pk = readWorkflow("gz-daily-pk.yml");
    const dispatch = pk.slice(pk.indexOf("  workflow_dispatch:"), pk.indexOf("jobs:"));

    expect(dispatch).toContain("deal_outcomes:");
    expect(dispatch).toContain("type: boolean");
    expect(dispatch).toContain("default: true");
  });
});

describe("GZ parallel PK and main collection", () => {
  it("keys the concurrency group by runs-dir so PK and main do not queue behind each other", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toContain("group: gz-automation-${{ inputs.runs-dir }}");
    expect(reusable).not.toMatch(/group: gz-automation\s*$/m);
    expect(reusable).toContain("cancel-in-progress: false");
  });

  it("uses a different runs-dir and cache scope for PK and main", () => {
    const pk = readWorkflow("gz-daily-pk.yml");
    const main = readWorkflow("gz-daily-main.yml");

    expect(pk).toContain("runs-dir: runs/pk");
    expect(pk).toContain("cache-scope: pk");
    expect(main).toContain("runs-dir: runs");
    expect(main).toContain("cache-scope: main");
  });

  it("keeps the plan cache separate per scope and falls back to the legacy shared key", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toContain("key: gz-db-${{ inputs.cache-scope }}-${{ github.run_id }}");
    expect(reusable).toContain("gz-db-${{ inputs.cache-scope }}-\n            gz-db-");
  });
});

describe("GZ GitHub workflow browser setup", () => {
  it("installs the Playwright browser without refreshing external apt repositories", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toContain("npx playwright install chromium");
    expect(reusable).not.toContain("playwright install --with-deps");
  });
});

describe("GZ portal intermediate certificate", () => {
  const certPath = "certs/rapidssl-tls-rsa-ca-g1.crt";
  const envLine = "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/" + certPath;

  it("ships the PEM certificate the portal does not send", () => {
    const pem = fs.readFileSync(path.resolve(certPath), "utf8");

    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(pem.trim()).toMatch(/-----END CERTIFICATE-----$/);
    expect(pem).not.toMatch(/PRIVATE KEY/);
  });

  it("trusts it for the collection and for the deal outcome check", () => {
    expect(readWorkflow("gz-automation.yml")).toContain(envLine);
    const pk = readWorkflow("gz-daily-pk.yml");
    expect(pk.slice(pk.indexOf("  deal-outcomes:"))).toContain(envLine);
  });
});

describe("GZ run summary", () => {
  it("writes the run summary to the job page even when the run failed", () => {
    const reusable = readWorkflow("gz-automation.yml");
    const step = reusable.slice(reusable.indexOf("      - name: Run summary"));
    const block = step.slice(0, step.indexOf("      - name: Save plan cache"));

    expect(block).toContain("if: always()");
    expect(block).toContain("continue-on-error: true");
    expect(block).toContain("scripts/gz-run-summary.mts '${{ inputs.runs-dir }}'");
    expect(block).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });
});

describe("CI workflow", () => {
  const ci = readWorkflow("ci.yml");

  it("runs on pull requests and on pushes to main", () => {
    expect(ci).toMatch(/on:\s+pull_request:\s+push:\s+branches: \[main\]/);
  });

  it("checks types and runs the whole test suite", () => {
    expect(ci).toContain("npm run lint");
    expect(ci).toContain("npm test");
  });

  it("provides what the KGD tests need: Python with reportlab and Chromium", () => {
    expect(ci).toContain("actions/setup-python@v5");
    expect(ci).toContain("pip install reportlab");
    expect(ci).toContain("npx playwright install chromium");
  });

  it("never gets secrets or write access", () => {
    expect(ci).not.toContain("secrets.");
    expect(ci).toMatch(/permissions:\s+contents: read/);
  });
});

describe("GZ portal outage retry", () => {
  it("runs the automation through the retry wrapper", () => {
    const reusable = readWorkflow("gz-automation.yml");

    expect(reusable).toContain("sh scripts/run-automation-with-retry.sh '${{ inputs.config }}' '${{ inputs.log-path }}'");
    expect(reusable).not.toContain("sh scripts/run-automation.sh");
  });
});

