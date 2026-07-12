import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveAutomationRun, prepareAutomationRun } from "../../src/automation/orchestrator.js";
import { readManifest } from "../../src/automation/core.js";
import type { AutomationConfig, AutomationDependencies } from "../../src/automation/types.js";

const dirs: string[]=[]; afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function root(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"s2l-orch-"));dirs.push(d);return d;}
function config(runsDir:string):AutomationConfig{return {runsDir,keepSuccessfulRuns:30,lockPath:path.join(runsDir,"prepare.lock"),staleLockMinutes:180,plansConfig:"plans.json",lotsConfig:"lots.json",periodMonths:6,approvalLimit:null};}
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
