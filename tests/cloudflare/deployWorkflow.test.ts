import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const deploy = fs.readFileSync(path.resolve(".github/workflows/deploy-worker.yml"), "utf8");

describe("Cloudflare Worker deploy workflow", () => {
  it("deploys on pushes to main that touch the Worker folder, and by hand", () => {
    expect(deploy).toMatch(/push:\s+branches: \[main\]\s+paths:\s+- "infra\/cloudflare-github-dispatch\/\*\*"/);
    expect(deploy).toContain("workflow_dispatch:");
  });

  it("does not deploy when only its own file changes, so merging it cannot fail before the secret exists", () => {
    const paths = deploy.slice(deploy.indexOf("paths:"), deploy.indexOf("workflow_dispatch:"));

    expect(paths).not.toContain("deploy-worker.yml");
  });

  it("deploys through the package script with the Cloudflare token from secrets", () => {
    expect(deploy).toContain("run: npm run cloudflare:deploy");
    expect(deploy).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
  });

  it("fails with a clear message instead of skipping silently when the token is missing", () => {
    const check = deploy.slice(deploy.indexOf("Check Cloudflare token"), deploy.indexOf("Deploy Worker"));

    expect(check).toContain('[ -z "$CLOUDFLARE_API_TOKEN" ]');
    expect(check).toContain("::error::");
    expect(check).toContain("exit 1");
  });

  it("never cancels a deploy in progress and gets read-only repository access", () => {
    expect(deploy).toMatch(/group: deploy-worker\s+cancel-in-progress: false/);
    expect(deploy).toMatch(/permissions:\s+contents: read/);
  });
});
