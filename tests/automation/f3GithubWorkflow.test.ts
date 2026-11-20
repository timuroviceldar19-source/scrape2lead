import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowsDir = path.resolve(".github/workflows");

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}

describe("F3 B2B daily collection workflow", () => {
  it("runs the F3 automation config through the reusable F3 body with the Bitrix webhook", () => {
    const daily = readWorkflow("f3-daily.yml");

    expect(daily).toContain("workflow_dispatch:");
    expect(daily).toContain("uses: ./.github/workflows/f3-automation.yml");
    expect(daily).toContain("config: config/automation.f3.json");
    expect(daily).toContain("runs-dir: runs/f3");
    expect(daily).toContain("BITRIX24_WEBHOOK_URL: ${{ secrets.BITRIX24_WEBHOOK_URL }}");
  });

  it("keeps the GitHub cron only as a backstop after the 09:30 Worker dispatch", () => {
    const daily = readWorkflow("f3-daily.yml");

    // 05:30 UTC = 10:30 Алматы: через час после диспетча Worker в 04:30 UTC.
    expect(daily).toContain('cron: "30 5 * * *"');
    expect(daily).not.toContain('cron: "10 4 * * *"');
    expect(daily).toContain("gh run list --workflow f3-daily.yml");
    expect(daily).toContain('if [ "$EVENT" != "schedule" ]');
  });

  it("queues F3 runs in their own concurrency group, apart from GZ", () => {
    const body = readWorkflow("f3-automation.yml");

    expect(body).toContain("workflow_call:");
    expect(body).toMatch(/concurrency:\s+group: f3-automation\s+cancel-in-progress: false/);
    expect(body).not.toMatch(/group: gz-automation/);
    expect(body).toContain("TZ: Asia/Almaty");
    expect(body).toContain("sh scripts/run-automation.sh");
    expect(body).toContain("key: f3-db-${{ github.run_id }}");
  });
});
