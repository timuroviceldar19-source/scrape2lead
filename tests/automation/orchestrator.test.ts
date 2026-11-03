import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveAutomationRun, prepareAutomationRun, pushAutomationRun, runScheduledAutomation } from "../../src/automation/orchestrator.js";
import { readManifest, writeManifestAtomic } from "../../src/automation/core.js";
import type { AutomationConfig, AutomationDependencies, AutomationManifest, AutomationWorkflow } from "../../src/automation/types.js";

const dirs: string[]=[]; afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
function root(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"s2l-orch-"));dirs.push(d);return d;}
function config(runsDir:string,workflow:AutomationWorkflow="plans-and-lots"):AutomationConfig{return {runsDir,keepSuccessfulRuns:30,lockPath:path.join(runsDir,"prepare.lock"),staleLockMinutes:180,plansConfig:"plans.json",lotsConfig:"lots.json",procurementConfig:"procurement.json",periodMonths:6,approvalLimit:null,deliveryMode:"push",workflow};}
function pkConfig(runsDir:string):AutomationConfig{return config(runsDir,"plans-only");}
function f3Config(runsDir:string,deliveryMode:AutomationConfig["deliveryMode"]="push"):AutomationConfig{return {...config(runsDir,"f3-b2b"),deliveryMode,periodMonths:7};}
function f3Deps():AutomationDependencies{
  return {...deps(),procurement:{
    collect: vi.fn(async(_cfg,outDir)=>{
      const xlsxPath=path.join(outDir,"f3.xlsx"), jsonPath=path.join(outDir,"f3.json");
      fs.writeFileSync(xlsxPath,"xlsx"); fs.writeFileSync(jsonPath,"json");
      return {xlsxPath,jsonPath,counts:{collected:7,data:3,review:2,rejected:2,yearConflicts:0,monthUnknown:5},criticalErrors:[],warnings:["plan-year:2027:not_open_yet"]};
    }),
    dryRun: vi.fn(async()=>({counts:{create:3,update:0,duplicate:0,failed:0},criticalErrors:[]})),
    apply: vi.fn(async()=>({counts:{create:3,update:0,duplicate:0,failed:0}}))
  }};
}
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

describe("independent GZ collection branches", () => {
  it.each(["plans", "lots"] as const)("resumes a transient %s push and clears only its obsolete error", async branch => {
    const runs = root(), d = deps(), cfg = config(runs);
    const failed = branch === "plans" ? d.applyPlans : d.applyLots;
    const successful = branch === "plans" ? d.applyLots : d.applyPlans;
    vi.mocked(failed).mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
    const first = await runScheduledAutomation(cfg, d);
    expect(first.status).toBe("pushed");
    const manifestPath = path.join(runs, first.runId, "manifest.json");
    first.errors.push({ stage: "exportPlans", message: "earlier partial search", at: first.createdAt });
    writeManifestAtomic(manifestPath, first);
    const resumed = await pushAutomationRun(cfg, first.runId, d);
    expect(resumed.errors).toEqual([expect.objectContaining({ stage: "exportPlans" })]);
    expect(failed).toHaveBeenCalledTimes(2);
    expect(successful).toHaveBeenCalledTimes(1);
    expect(readManifest(manifestPath).errors).toEqual(resumed.errors);
    await expect(pushAutomationRun(cfg, first.runId, d)).rejects.toThrow(/already pushed/);
  });
  it.each(["plans", "lots"] as const)("resumes approval after a transient %s failure", async branch => {
    const runs = root(), d = deps(), cfg = config(runs);
    const failed = branch === "plans" ? d.applyPlans : d.applyLots;
    vi.mocked(failed).mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
    const prepared = await prepareAutomationRun(cfg, d);
    expect((await approveAutomationRun(cfg, prepared.runId, d)).status).toBe("applied");
    const resumed = await approveAutomationRun(cfg, prepared.runId, d);
    expect(resumed.status).toBe("applied");
    expect(resumed.errors).toEqual([]);
    expect(d.applyPlans).toHaveBeenCalledTimes(branch === "plans" ? 2 : 1);
    expect(d.applyLots).toHaveBeenCalledTimes(branch === "lots" ? 2 : 1);
    expect(d.analyzeLots).toHaveBeenCalledTimes(1);
    await expect(approveAutomationRun(cfg, prepared.runId, d)).rejects.toThrow(/already applied/);
  });
  it("prints a shell-retry marker even when TimeoutError has no network text in its message", async () => {
    const runs = root(), d = deps();
    const failure = new Error("navigation expired"); failure.name = "TimeoutError";
    vi.mocked(d.exportPlans).mockRejectedValue(failure);
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runScheduledAutomation(pkConfig(runs), d);
      expect(result.status).toBe("failed");
      expect(printed.mock.calls.flat().join("\n")).toMatch(/fetch failed|TimeoutError/);
    } finally { printed.mockRestore(); }
  });
  it.each(["plans", "lots"] as const)("pushes the other branch when %s is unreachable", async failed => {
    const runs = root(), d = deps();
    vi.mocked(failed === "plans" ? d.exportPlans : d.exportLots).mockRejectedValue(new Error("page.goto: Timeout 90000ms exceeded"));
    const result = await runScheduledAutomation(config(runs), d);
    expect(result.status).toBe("pushed");
    expect(failed === "plans" ? d.dryRunLots : d.dryRunPlans).toHaveBeenCalledTimes(1);
    expect(failed === "plans" ? d.applyLots : d.applyPlans).toHaveBeenCalledTimes(1);
    expect(failed === "plans" ? d.applyPlans : d.applyLots).not.toHaveBeenCalled();
    expect(result.errors).toEqual([expect.objectContaining({ stage: failed === "plans" ? "exportPlans" : "exportLots" })]);
    const summary = fs.readFileSync(path.join(runs, result.runId, "summary.txt"), "utf8");
    expect(summary).toContain("Timeout");
  });
  it("fails without pushing when both sources are unreachable", async () => {
    const runs = root(), d = deps();
    vi.mocked(d.exportPlans).mockRejectedValue(new Error("fetch failed: ETIMEDOUT"));
    vi.mocked(d.exportLots).mockRejectedValue(new Error("page.goto: Timeout"));
    const result = await runScheduledAutomation(config(runs), d);
    expect(result.status).toBe("failed"); expect(result.errors).toHaveLength(2);
    expect(d.applyPlans).not.toHaveBeenCalled(); expect(d.applyLots).not.toHaveBeenCalled();
  });
  it("persists partial query details on a successful export stage", async () => {
    const runs = root(), d = deps();
    const skipped = [{ stage: "plans" as const, query: "Панель", year: 2027, months: [1], failedPage: 2,
      totalPages: 3, keptRows: 2, attempts: 3, reason: "page.goto: Timeout" }];
    vi.mocked(d.exportPlans).mockImplementation(async (_cfg, out) => {
      fs.writeFileSync(out, "plans"); return { path: out, rows: 2, skippedQueries: skipped, successfulQueries: 1 };
    });
    const result = await runScheduledAutomation(config(runs), d);
    expect(result.status).toBe("pushed");
    expect(result.stages.exportPlans).toMatchObject({ status: "succeeded", counts: { skipped_queries: 1 }, skipped });
    expect(fs.readFileSync(path.join(runs, result.runId, "summary.txt"), "utf8")).toContain("Панель");
  });
  it("allows preparing and approving only the available lots branch", async () => {
    const runs = root(), d = deps(); vi.mocked(d.exportPlans).mockRejectedValue(new Error("page.goto: Timeout"));
    const prepared = await prepareAutomationRun(config(runs), d);
    expect(prepared.status).toBe("ready");
    const applied = await approveAutomationRun(config(runs), prepared.runId, d);
    expect(applied.status).toBe("applied"); expect(d.applyPlans).not.toHaveBeenCalled();
    expect(d.applyLots).toHaveBeenCalledTimes(1); expect(d.analyzeLots).toHaveBeenCalledTimes(1);
  });
  it("does not let an unreachable branch bypass hash checks of the available branch", async () => {
    const runs = root(), d = deps(); vi.mocked(d.exportLots).mockRejectedValue(new Error("page.goto: Timeout"));
    const prepared = await prepareAutomationRun(config(runs), d);
    fs.appendFileSync(prepared.artifacts.plans!.path, "tamper");
    await expect(pushAutomationRun(config(runs), prepared.runId, d)).rejects.toThrow(/hash mismatch/);
    expect(d.applyPlans).not.toHaveBeenCalled();
  });
  it("continues lots after a transient plans push failure", async () => {
    const runs = root(), d = deps(); vi.mocked(d.applyPlans).mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    const result = await runScheduledAutomation(config(runs), d);
    expect(result.status).toBe("pushed"); expect(d.applyLots).toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([expect.objectContaining({ stage: "applyPlans" })]);
  });
});

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
  it("persists exportPlans cache metrics into the manifest stage counts",async()=>{
    const runs=root(), d=deps();
    vi.mocked(d.exportPlans).mockImplementation(async(_cfg,out)=>{fs.writeFileSync(out,"plans");return {path:out,rows:2,cacheHit:5,cacheMiss:3,fetched:2,fetchFailed:1};});
    const result=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    expect(result.stages.exportPlans.counts).toEqual({rows:2,cache_hit:5,cache_miss:3,fetched:2,fetch_failed:1});
    // Lots export has no detail cache: only rows is recorded.
    expect(result.stages.exportLots.counts).toEqual({rows:3});
  });
  it("records AI failure and resumes only AI",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    vi.mocked(d.analyzeLots).mockRejectedValueOnce(new Error("AI down"));
    expect((await approveAutomationRun(config(runs),prepared.runId,d)).status).toBe("applied_ai_failed");
    expect((await approveAutomationRun(config(runs),prepared.runId,d)).status).toBe("applied");
    expect(readManifest(path.join(runs,prepared.runId,"manifest.json")).errors).toEqual([]);
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

describe("f3-b2b workflow",()=>{
  it("collects, dry-runs and reports without touching any GZ stage",async()=>{
    const runs=root(), d=f3Deps();
    const result=await prepareAutomationRun(f3Config(runs),d,new Date("2026-07-27T10:00:00Z"));

    expect(result.status).toBe("ready");
    expect(result.schemaVersion).toBe(4);
    expect(Object.keys(result.artifacts).sort()).toEqual(["procurementDryRun","procurementReport","procurementXlsx"]);
    for(const fn of [d.exportPlans,d.exportLots,d.dryRunPlans,d.dryRunLots,d.applyPlans,d.applyLots,d.analyzeLots]){
      expect(fn).not.toHaveBeenCalled();
    }
    expect(d.procurement!.collect).toHaveBeenCalledWith("procurement.json",path.join(runs,result.runId),[2026,2027]);
    expect(d.procurement!.dryRun).toHaveBeenCalledWith(
      result.artifacts.procurementReport!.path,
      result.artifacts.procurementDryRun!.path,
      "procurement.json"
    );
  });

  it("writes a run report with the counts an operator needs",async()=>{
    const runs=root(), d=f3Deps();
    const result=await prepareAutomationRun(f3Config(runs),d,new Date("2026-07-27T10:00:00Z"));
    const report=fs.readFileSync(path.join(runs,result.runId,"f3-report.txt"),"utf8");

    expect(report).toContain("collected=7"); expect(report).toContain("accepted=3");
    expect(report).toContain("rejected=2"); expect(report).toContain("year_conflicts=0");
    expect(report).toContain("month_unknown=5"); expect(report).toContain("new=3");
    expect(report).toContain("updates=0"); expect(report).toContain("duplicates=0");
    expect(report).toContain("warning=plan-year:2027:not_open_yet");
  });

  it("fails prepare when the collection reports a blocking problem",async()=>{
    const runs=root(), d=f3Deps();
    vi.mocked(d.procurement!.collect).mockResolvedValue({
      xlsxPath:path.join(runs,"x.xlsx"),jsonPath:path.join(runs,"x.json"),
      counts:{},criticalErrors:["plan_year_conflicts:3"]
    });
    const result=await prepareAutomationRun(f3Config(runs),d,new Date("2026-07-27T10:00:00Z"));

    expect(result.status).toBe("failed");
    expect(d.procurement!.dryRun).not.toHaveBeenCalled();
  });

  it("stops a scheduled run at ready while delivery stays in prepare mode",async()=>{
    const runs=root(), d=f3Deps();
    const result=await runScheduledAutomation(f3Config(runs,"prepare"),d,new Date("2026-07-27T10:00:00Z"));

    expect(result.status).toBe("ready");
    expect(d.procurement!.apply).not.toHaveBeenCalled();
  });

  it("pushes from the verified report once delivery mode is push",async()=>{
    const runs=root(), d=f3Deps();
    const result=await runScheduledAutomation(f3Config(runs,"push"),d,new Date("2026-07-27T10:00:00Z"));

    expect(result.status).toBe("pushed");
    expect(d.procurement!.apply).toHaveBeenCalledWith(result.artifacts.procurementReport!.path,null,"procurement.json");
  });

  it("refuses to push a report that changed after the dry-run",async()=>{
    const runs=root(), d=f3Deps();
    const prepared=await prepareAutomationRun(f3Config(runs),d,new Date("2026-07-27T10:00:00Z"));
    fs.appendFileSync(prepared.artifacts.procurementReport!.path,"tamper");

    await expect(pushAutomationRun(f3Config(runs),prepared.runId,d)).rejects.toThrow(/procurement report artifact hash mismatch/);
    expect(d.procurement!.apply).not.toHaveBeenCalled();
  });

  it("rejects approve the same way plans-only does",async()=>{
    const runs=root(), d=f3Deps();
    const prepared=await prepareAutomationRun(f3Config(runs),d,new Date("2026-07-27T10:00:00Z"));
    await expect(approveAutomationRun(f3Config(runs),prepared.runId,d)).rejects.toThrow(/f3-b2b/);
  });

  it("fails loudly when the procurement adapter is absent",async()=>{
    const runs=root();
    const result=await prepareAutomationRun(f3Config(runs),deps(),new Date("2026-07-27T10:00:00Z"));
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toMatch(/requires the procurement dependency adapter/);
  });
});

describe("automation manifest compatibility",()=>{
  it("treats a v2 manifest without a workflow as a full plans-and-lots run",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    const manifestPath=path.join(runs,prepared.runId,"manifest.json");
    const legacy=readManifest(manifestPath) as AutomationManifest & {workflow?:AutomationWorkflow};
    legacy.schemaVersion=2; delete legacy.workflow; delete legacy.preparedBranches; writeManifestAtomic(manifestPath,legacy);
    const pushed=await pushAutomationRun(config(runs),prepared.runId,d);
    expect(pushed.status).toBe("pushed");
    expect(d.applyPlans).toHaveBeenCalledTimes(1); expect(d.applyLots).toHaveBeenCalledTimes(1);
  });
  it("still requires lots artifacts for a v1 manifest without a workflow",async()=>{
    const runs=root(), d=deps(); const prepared=await prepareAutomationRun(config(runs),d,new Date("2026-07-12T10:00:00Z"));
    const manifestPath=path.join(runs,prepared.runId,"manifest.json");
    const legacy=readManifest(manifestPath) as AutomationManifest & {workflow?:AutomationWorkflow};
    legacy.schemaVersion=1; delete legacy.workflow; delete legacy.preparedBranches; delete legacy.artifacts.lots; writeManifestAtomic(manifestPath,legacy);
    await expect(pushAutomationRun(config(runs),prepared.runId,d)).rejects.toThrow(/lots artifact is missing/);
    expect(d.applyPlans).not.toHaveBeenCalled();
  });
});
