import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveAutomationRun, prepareAutomationRun, pushAutomationRun, runScheduledAutomation } from "../../src/automation/orchestrator.js";
import { readManifest, writeManifestAtomic } from "../../src/automation/core.js";
import type { AutomationConfig, AutomationDependencies, AutomationManifest, AutomationWorkflow } from "../../src/automation/types.js";

const dirs: string[]=[]; afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function root(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"s2l-orch-"));dirs.push(d);return d;}
function config(runsDir:string,workflow:AutomationWorkflow="plans-and-lots"):AutomationConfig{return {runsDir,keepSuccessfulRuns:30,lockPath:path.join(runsDir,"prepare.lock"),staleLockMinutes:180,plansConfig:"plans.json",lotsConfig:"lots.json",periodMonths:6,approvalLimit:null,workflow};}
function pkConfig(runsDir:string):AutomationConfig{return config(runsDir,"plans-only");}
function deps():AutomationDependencies {
  return {
    exportPlans: vi.fn(async (_cfg,out)=>{fs.writeFileSync(out,"plans");return {path:out,rows:2};}),
    exportLots: vi.fn(async (_cfg,out)=>{fs.writeFileSync(out,"lots");return {path:out,rows:3};}),
    dryRunPlans: vi.fn(async()=>({counts:{candidate:2},criticalErrors:[]})),
    dryRunLots: vi.fn(async()=>({counts:{candidate:3},criticalErrors:[]})),
    applyPlans: vi.fn(async()=>({counts:{created:2}})),
    applyLots: vi.fn(async()=>({counts:{created:3}})),
    analyzeLots: vi.fn(async()=>({counts:{analyzed:3}}))
  };
}

describe("automation orchestrator",()=>{
  it("prepares both artifacts without applying CRM or AI",async()=>{
    const runs=root(), d=deps(); const result=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    expect(result.status).toBe("ready"); expect(d.applyPlans).not.toHaveBeenCalled(); expect(d.applyLots).not.toHaveBeenCalled(); expect(d.analyzeLots).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(runs,result.runId,"summary.txt"))).toBe(true);
  });
  it("marks prepare failed and blocks approval when one collector fails",async()=>{
    const runs=root(), d=deps(); vi.mocked(d.exportLots).mockRejectedValue(new Error("lots down"));
    const result=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z")); expect(result.status).toBe("failed");
    await expect(approveAutomationRun(config(runs),result.runId,d)).rejects.toThrow(/not ready/);
  });
  it("blocks approval when a dry-run reports critical errors",async()=>{
    const runs=root(), d=deps(); vi.mocked(d.dryRunPlans).mockResolvedValue({counts:{candidate:2},criticalErrors:["invalid routing"]});
    const result=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    expect(result.status).toBe("failed"); expect(result.stages.dryRunPlans.status).toBe("failed");
    await expect(approveAutomationRun(config(runs),result.runId,d)).rejects.toThrow(/not ready/);
  });
  it("rejects approval when an artifact changed",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    fs.appendFileSync(prepared.artifacts.plans!.path,"tamper");
    await expect(approveAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/hash mismatch/);
  });
  it("applies plans, lots and AI once",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    const applied=await approveAutomationRun(config(runs),prepared.runId,d); expect(applied.status).toBe("applied");
    await expect(approveAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/already applied/);
  });
  it("records AI failure and resumes only AI",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    vi.mocked(d.analyzeLots).mockRejectedValueOnce(new Error("AI down"));
    expect((await approveAutomationRun(config(runs),prepared.runId,d)).status).toBe("applied_ai_failed");
    expect((await approveAutomationRun(config(runs),prepared.runId,d)).status).toBe("applied");
    expect(d.applyPlans).toHaveBeenCalledTimes(1); expect(d.applyLots).toHaveBeenCalledTimes(1); expect(d.analyzeLots).toHaveBeenCalledTimes(2);
    expect(readManifest(path.join(runs,prepared.runId,"manifest.json")).status).toBe("applied");
  });
});

describe("automation scheduled push",()=>{
  it("prepares then pushes plans and lots without running AI",async()=>{
    const runs=root(), d=deps(); const result=await runScheduledAutomation(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    expect(result.status).toBe("pushed"); expect(result.schemaVersion).toBe(3); expect(result.workflow).toBe("plans-and-lots");
    expect(d.applyPlans).toHaveBeenCalledTimes(1); expect(d.applyLots).toHaveBeenCalledTimes(1);
    expect(d.analyzeLots).not.toHaveBeenCalled();
    expect(result.stages.applyPlans.status).toBe("succeeded"); expect(result.stages.applyLots.status).toBe("succeeded");
  });
  it("does not push when prepare fails",async()=>{
    const runs=root(), d=deps(); vi.mocked(d.exportLots).mockRejectedValue(new Error("lots down"));
    const result=await runScheduledAutomation(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    expect(result.status).toBe("failed");
    expect(d.applyPlans).not.toHaveBeenCalled(); expect(d.applyLots).not.toHaveBeenCalled();
  });
  it("rejects a push when an artifact changed",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    fs.appendFileSync(prepared.artifacts.plans!.path,"tamper");
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/hash mismatch/);
    expect(d.applyPlans).not.toHaveBeenCalled();
  });
  it("blocks a push when prepare is not ready",async()=>{
    const runs=root(), d=deps(); vi.mocked(d.dryRunPlans).mockResolvedValue({counts:{candidate:2},criticalErrors:["invalid routing"]});
    const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z")); expect(prepared.status).toBe("failed");
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/not ready/);
  });
  it("stops at a plans push failure and does not start lots",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    vi.mocked(d.applyPlans).mockRejectedValueOnce(new Error("plans down"));
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/plans down/);
    expect(d.applyLots).not.toHaveBeenCalled();
    const manifest=readManifest(path.join(runs,prepared.runId,"manifest.json"));
    expect(manifest.status).toBe("failed"); expect(manifest.stages.applyPlans.status).toBe("failed");
  });
  it("resumes lots after a partial push without re-pushing plans",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    vi.mocked(d.applyLots).mockRejectedValueOnce(new Error("lots down"));
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/lots down/);
    const resumed=await pushAutomationRun(config(runs),prepared.runId,d);
    expect(resumed.status).toBe("pushed");
    expect(d.applyPlans).toHaveBeenCalledTimes(1); expect(d.applyLots).toHaveBeenCalledTimes(2);
  });
  it("rejects re-pushing an already pushed run",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    await pushAutomationRun(config(runs),prepared.runId,d);
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/already pushed/);
  });
  it("approves only AI after a pushed run",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    await pushAutomationRun(config(runs),prepared.runId,d);
    const applied=await approveAutomationRun(config(runs),prepared.runId,d);
    expect(applied.status).toBe("applied");
    expect(d.applyPlans).toHaveBeenCalledTimes(1); expect(d.applyLots).toHaveBeenCalledTimes(1); expect(d.analyzeLots).toHaveBeenCalledTimes(1);
  });
});

describe("automation plans-only workflow",()=>{
  it("prepares plans without collecting lots",async()=>{
    const runs=root(), d=deps(); const result=await prepareAutomationRun(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    expect(result.status).toBe("ready"); expect(result.schemaVersion).toBe(3); expect(result.workflow).toBe("plans-only");
    expect(d.exportPlans).toHaveBeenCalledTimes(1); expect(d.dryRunPlans).toHaveBeenCalledTimes(1);
    expect(d.exportLots).not.toHaveBeenCalled(); expect(d.dryRunLots).not.toHaveBeenCalled();
    expect(result.artifacts.plans).toBeDefined(); expect(result.artifacts.plansDryRun).toBeDefined();
    expect(result.artifacts.lots).toBeUndefined(); expect(result.artifacts.lotsDryRun).toBeUndefined();
  });
  it("pushes plans only, never lots or AI",async()=>{
    const runs=root(), d=deps(); const result=await runScheduledAutomation(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    expect(result.status).toBe("pushed"); expect(d.applyPlans).toHaveBeenCalledTimes(1);
    expect(d.applyLots).not.toHaveBeenCalled(); expect(d.analyzeLots).not.toHaveBeenCalled();
    expect(result.stages.applyPlans.status).toBe("succeeded"); expect(result.stages.applyLots).toBeUndefined();
  });
  it("rejects a plans-only push when the plans artifact changed",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    fs.appendFileSync(prepared.artifacts.plans!.path,"tamper");
    await expect(pushAutomationRun(pkConfig(runs),prepared.runId,d)).rejects.toThrow(/hash mismatch/);
    expect(d.applyPlans).not.toHaveBeenCalled();
  });
  it("rejects a plans-only push when the dry-run report changed",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    fs.appendFileSync(prepared.artifacts.plansDryRun!.path,"tamper");
    await expect(pushAutomationRun(pkConfig(runs),prepared.runId,d)).rejects.toThrow(/hash mismatch/);
    expect(d.applyPlans).not.toHaveBeenCalled();
  });
  it("does not push when the plans dry-run has critical errors",async()=>{
    const runs=root(), d=deps(); vi.mocked(d.dryRunPlans).mockResolvedValue({counts:{candidate:2},criticalErrors:["invalid routing"]});
    const result=await runScheduledAutomation(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    expect(result.status).toBe("failed"); expect(d.applyPlans).not.toHaveBeenCalled();
  });
  it("does not push when the plans collector fails",async()=>{
    const runs=root(), d=deps(); vi.mocked(d.exportPlans).mockRejectedValue(new Error("plans down"));
    const result=await runScheduledAutomation(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    expect(result.status).toBe("failed"); expect(d.applyPlans).not.toHaveBeenCalled();
  });
  it("resumes a failed plans-only push without re-collecting",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    vi.mocked(d.applyPlans).mockRejectedValueOnce(new Error("bitrix down"));
    await expect(pushAutomationRun(pkConfig(runs),prepared.runId,d)).rejects.toThrow(/bitrix down/);
    expect(readManifest(path.join(runs,prepared.runId,"manifest.json")).status).toBe("failed");
    const resumed=await pushAutomationRun(pkConfig(runs),prepared.runId,d);
    expect(resumed.status).toBe("pushed");
    expect(d.exportPlans).toHaveBeenCalledTimes(1); expect(d.applyPlans).toHaveBeenCalledTimes(2);
  });
  it("rejects re-pushing an already pushed plans-only run",async()=>{
    const runs=root(), d=deps(); const prepared=await runScheduledAutomation(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    await expect(pushAutomationRun(pkConfig(runs),prepared.runId,d)).rejects.toThrow(/already pushed/);
  });
  it("refuses approval and AI analysis for a plans-only run",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(pkConfig(runs),d,new Date("2026-07-12T11:00:00Z"));
    await expect(approveAutomationRun(pkConfig(runs),prepared.runId,d)).rejects.toThrow(/plans-only/);
    expect(d.applyPlans).not.toHaveBeenCalled(); expect(d.analyzeLots).not.toHaveBeenCalled();
  });
});

describe("automation manifest compatibility",()=>{
  it("treats a v2 manifest without a workflow as a full plans-and-lots run",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    const manifestPath=path.join(runs,prepared.runId,"manifest.json");
    const legacy=readManifest(manifestPath) as AutomationManifest & {workflow?:AutomationWorkflow};
    legacy.schemaVersion=2; delete legacy.workflow; writeManifestAtomic(manifestPath,legacy);
    const pushed=await pushAutomationRun(config(runs),prepared.runId,d);
    expect(pushed.status).toBe("pushed");
    expect(d.applyPlans).toHaveBeenCalledTimes(1); expect(d.applyLots).toHaveBeenCalledTimes(1);
  });
  it("still requires lots artifacts for a v1 manifest without a workflow",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    const manifestPath=path.join(runs,prepared.runId,"manifest.json");
    const legacy=readManifest(manifestPath) as AutomationManifest & {workflow?:AutomationWorkflow};
    legacy.schemaVersion=1; delete legacy.workflow; delete legacy.artifacts.lots; writeManifestAtomic(manifestPath,legacy);
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/lots artifact is missing/);
    expect(d.applyPlans).not.toHaveBeenCalled();
  });
});
