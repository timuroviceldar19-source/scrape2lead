import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { TwoGisAdapter } from "../src/adapters/2gis/TwoGisAdapter.js";
import { BrowserSessionManager } from "../src/browser/browserSessionManager.js";
import { loadConfig } from "../src/config/config.js";
import { JobManager } from "../src/core/jobManager.js";
import { Storage } from "../src/storage/storage.js";
import type { Lead, RuntimeConfig } from "../src/types.js";
import {
  ENVIRONMENT_BLOCKED_EXIT_CODE,
  runAuditHealthGate,
  type AuditHealthGateResult
} from "./auditHealthGate.js";

export const AUDIT_THRESHOLDS = {
  leads: 50,
  phone: 50,
  address: 49,
  email: 20,
  incomplete: 1,
  detailsFailed: 2
} as const;

export type AuditStatus = "PASS" | "FAIL" | "ENVIRONMENT_BLOCKED";

export interface AuditDiagnosticsSummary {
  detailsAttempted: number;
  detailsFailed: number;
  websiteDiscoverySucceeded: number;
  websiteCrawlSucceeded: number;
  directoryDiscoverySucceeded: number;
}

export interface AuditMetrics {
  total: number;
  phone: number;
  address: number;
  website: number;
  email: number;
  messengers: number;
  incomplete: number;
  detailsFailed: number;
}

export interface AuditEvaluation {
  status: Extract<AuditStatus, "PASS" | "FAIL">;
  failures: string[];
}

export interface AuditRunResult {
  status: AuditStatus;
  exitCode: number;
  metrics?: AuditMetrics;
  diagnostics?: AuditDiagnosticsSummary;
  healthGate: AuditHealthGateResult;
}

export function buildAuditConfig(): RuntimeConfig {
  const config = loadConfig("", {
    source: "2gis",
    geo: "Новосибирск",
    category: "Автосервисы",
    limit: 50,
    concurrency: 5
  });

  config.source = "2gis";
  config.geo = "Новосибирск";
  config.category = "Автосервисы";
  config.limit = 50;
  config.concurrency = 5;
  config.websiteDiscovery = { ...config.websiteDiscovery, enabled: true };
  config.websiteCrawl = { ...config.websiteCrawl, enabled: true };
  config.directoryContactDiscovery = { ...config.directoryContactDiscovery, enabled: true };
  return config;
}

export function summarizeAuditMetrics(
  leads: Lead[],
  diagnostics: Pick<AuditDiagnosticsSummary, "detailsFailed">
): AuditMetrics {
  let phone = 0;
  let address = 0;
  let website = 0;
  let email = 0;
  let messengers = 0;
  let incomplete = 0;

  for (const lead of leads) {
    if (lead.phones.length > 0) phone++;
    if (lead.address) address++;
    if (lead.website) website++;
    if (lead.email) email++;
    if (lead.messenger_links.length > 0) messengers++;
    if (lead.incomplete) incomplete++;
  }

  return {
    total: leads.length,
    phone,
    address,
    website,
    email,
    messengers,
    incomplete,
    detailsFailed: diagnostics.detailsFailed
  };
}

export function evaluateAuditMetrics(metrics: AuditMetrics): AuditEvaluation {
  const failures: string[] = [];

  if (metrics.total < AUDIT_THRESHOLDS.leads) {
    failures.push(`Total leads ${metrics.total} < baseline ${AUDIT_THRESHOLDS.leads}`);
  }
  if (metrics.phone < AUDIT_THRESHOLDS.phone) {
    failures.push(`Leads with phone ${metrics.phone} < baseline ${AUDIT_THRESHOLDS.phone}`);
  }
  if (metrics.address < AUDIT_THRESHOLDS.address) {
    failures.push(`Leads with address ${metrics.address} < baseline ${AUDIT_THRESHOLDS.address}`);
  }
  if (metrics.email < AUDIT_THRESHOLDS.email) {
    failures.push(`Leads with email ${metrics.email} < baseline ${AUDIT_THRESHOLDS.email}`);
  }
  if (metrics.incomplete > AUDIT_THRESHOLDS.incomplete) {
    failures.push(`Incomplete leads ${metrics.incomplete} > baseline ${AUDIT_THRESHOLDS.incomplete}`);
  }
  if (metrics.detailsFailed > AUDIT_THRESHOLDS.detailsFailed) {
    failures.push(`Details failed ${metrics.detailsFailed} > baseline ${AUDIT_THRESHOLDS.detailsFailed}`);
  }

  return {
    status: failures.length > 0 ? "FAIL" : "PASS",
    failures
  };
}

export async function runAudit(): Promise<AuditRunResult> {
  console.log("Starting Audit Regression Harness...");
  const config = buildAuditConfig();
  const browserSession = new BrowserSessionManager(config);
  let adapter: TwoGisAdapter | null = null;
  let storage: Storage | null = null;

  try {
    console.log("\n--- HEALTH GATE ---");
    const healthGate = await runAuditHealthGate(config, browserSession);
    if (healthGate.status === "environment_blocked") {
      console.error(`ENVIRONMENT_BLOCKED reason=${healthGate.reason}`);
      console.error(`Detail: ${healthGate.detail}`);
      if (healthGate.httpStatus !== undefined) console.error(`HTTP status: ${healthGate.httpStatus}`);
      console.error("Full live audit skipped because the environment cannot be measured fairly.");
      return { status: "ENVIRONMENT_BLOCKED", exitCode: ENVIRONMENT_BLOCKED_EXIT_CODE, healthGate };
    }
    console.log(
      `Health gate passed: apiCards=${healthGate.apiCards}, domCards=${healthGate.domCards}, httpStatus=${healthGate.httpStatus ?? "n/a"}`
    );

    const registry = new AdapterRegistry();
    adapter = new TwoGisAdapter(config, browserSession);
    registry.register(adapter);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dbPath = path.join(config.exportDir, `audit-regression-${timestamp}.db`);
    storage = new Storage(dbPath, config.rawSnapshotDir);

    const manager = new JobManager(config, registry, storage);
    const result = await manager.run();
    const { leads, diagnostics } = result;
    const metrics = summarizeAuditMetrics(leads, diagnostics);
    const diagnosticsSummary: AuditDiagnosticsSummary = {
      detailsAttempted: diagnostics.detailsAttempted,
      detailsFailed: diagnostics.detailsFailed,
      websiteDiscoverySucceeded: diagnostics.websiteDiscoverySucceeded,
      websiteCrawlSucceeded: diagnostics.websiteCrawlSucceeded,
      directoryDiscoverySucceeded: diagnostics.directoryDiscoverySucceeded
    };

    printAuditResults(metrics, diagnosticsSummary);
    const evaluation = evaluateAuditMetrics(metrics);
    for (const failure of evaluation.failures) {
      console.error(`FAILED: ${failure}`);
    }

    if (evaluation.status === "FAIL") {
      console.error("\nREGRESSION DETECTED! Run failed to meet baselines.");
      return { status: "FAIL", exitCode: 1, metrics, diagnostics: diagnosticsSummary, healthGate };
    }

    console.log("\nALL BASELINES MET! No regression detected.");
    return { status: "PASS", exitCode: 0, metrics, diagnostics: diagnosticsSummary, healthGate };
  } finally {
    storage?.close();
    await adapter?.close();
    if (!adapter) await browserSession.close();
  }
}

function printAuditResults(metrics: AuditMetrics, diagnostics: AuditDiagnosticsSummary): void {
  console.log("\n--- AUDIT RESULTS ---");
  console.log(`Total leads: ${metrics.total}`);
  console.log(`Leads with Phone: ${metrics.phone}`);
  console.log(`Leads with Address: ${metrics.address}`);
  console.log(`Leads with Website: ${metrics.website}`);
  console.log(`Leads with Email: ${metrics.email}`);
  console.log(`Leads with Messengers: ${metrics.messengers}`);
  console.log(`Incomplete leads: ${metrics.incomplete}`);

  console.log("\n--- DIAGNOSTICS ---");
  console.log(`Details Attempted: ${diagnostics.detailsAttempted}`);
  console.log(`Details Failed: ${diagnostics.detailsFailed}`);
  console.log(`Website Discovery Succeeded: ${diagnostics.websiteDiscoverySucceeded}`);
  console.log(`Website Crawl Succeeded: ${diagnostics.websiteCrawlSucceeded}`);
  console.log(`Directory Discovery Succeeded: ${diagnostics.directoryDiscoverySucceeded}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMainModule()) {
  runAudit()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((err) => {
      console.error("Audit script failed:", err);
      process.exitCode = 1;
    });
}
