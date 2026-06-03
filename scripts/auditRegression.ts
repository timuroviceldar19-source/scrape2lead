import path from "node:path";
import { JobManager } from "../src/core/jobManager.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { TwoGisAdapter } from "../src/adapters/2gis/TwoGisAdapter.js";
import { Storage } from "../src/storage/storage.js";
import { loadConfig } from "../src/config/config.js";

import { BrowserSessionManager } from "../src/browser/browserSessionManager.js";

async function runAudit() {
  console.log("Starting Audit Regression Harness...");
  const config = loadConfig("", {
    source: "2gis",
    geo: "Новосибирск",
    category: "Автосервисы",
    limit: 50,
    concurrency: 5
  });
  
  // Override config for audit
  config.source = "2gis";
  config.geo = "Новосибирск";
  config.category = "Автосервисы";
  config.limit = 50;
  config.concurrency = 5;
  config.websiteDiscovery.enabled = true;
  config.websiteCrawl.enabled = true;
  config.directoryContactDiscovery.enabled = true;
  
  // Set up dependencies
  const registry = new AdapterRegistry();
  const browserSession = new BrowserSessionManager(config);
  const adapter = new TwoGisAdapter(config, browserSession);
  registry.register(adapter);
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbPath = path.join(config.exportDir, `audit-regression-${timestamp}.db`);
  const storage = new Storage(dbPath, config.rawSnapshotDir);

  const manager = new JobManager(config, registry, storage);
  
  let result;
  try {
    result = await manager.run();
  } finally {
    await adapter.close();
    storage.close();
  }

  const { leads, diagnostics } = result;

  console.log(`\n--- AUDIT RESULTS ---`);
  console.log(`Total leads: ${leads.length}`);

  let withPhone = 0;
  let withAddress = 0;
  let withWebsite = 0;
  let withEmail = 0;
  let withMessengers = 0;
  let incomplete = 0;

  for (const lead of leads) {
    if (lead.phones.length > 0) withPhone++;
    if (lead.address) withAddress++;
    if (lead.website) withWebsite++;
    if (lead.email) withEmail++;
    if (lead.messenger_links.length > 0) withMessengers++;
    if (lead.incomplete) incomplete++;
  }

  console.log(`Leads with Phone: ${withPhone}`);
  console.log(`Leads with Address: ${withAddress}`);
  console.log(`Leads with Website: ${withWebsite}`);
  console.log(`Leads with Email: ${withEmail}`);
  console.log(`Leads with Messengers: ${withMessengers}`);
  console.log(`Incomplete leads: ${incomplete}`);

  console.log(`\n--- DIAGNOSTICS ---`);
  console.log(`Details Attempted: ${diagnostics.detailsAttempted}`);
  console.log(`Details Failed: ${diagnostics.detailsFailed}`);
  console.log(`Website Discovery Succeeded: ${diagnostics.websiteDiscoverySucceeded}`);
  console.log(`Website Crawl Succeeded: ${diagnostics.websiteCrawlSucceeded}`);
  console.log(`Directory Discovery Succeeded: ${diagnostics.directoryDiscoverySucceeded}`);

  // Assertions against baselines
  const thresholds = {
    leads: 50,
    phone: 50,
    address: 49,
    email: 20,
    incomplete: 1,
    detailsFailed: 2
  };

  let failed = false;

  if (leads.length < thresholds.leads) {
    console.error(`❌ FAILED: Total leads ${leads.length} < baseline ${thresholds.leads}`);
    failed = true;
  }
  if (withPhone < thresholds.phone) {
    console.error(`❌ FAILED: Leads with phone ${withPhone} < baseline ${thresholds.phone}`);
    failed = true;
  }
  if (withAddress < thresholds.address) {
    console.error(`❌ FAILED: Leads with address ${withAddress} < baseline ${thresholds.address}`);
    failed = true;
  }
  if (withEmail < thresholds.email) {
    console.error(`❌ FAILED: Leads with email ${withEmail} < baseline ${thresholds.email}`);
    failed = true;
  }
  if (incomplete > thresholds.incomplete) {
    console.error(`❌ FAILED: Incomplete leads ${incomplete} > baseline ${thresholds.incomplete}`);
    failed = true;
  }
  if (diagnostics.detailsFailed > thresholds.detailsFailed) {
    console.error(`❌ FAILED: Details failed ${diagnostics.detailsFailed} > baseline ${thresholds.detailsFailed}`);
    failed = true;
  }

  if (failed) {
    console.error(`\n🚨 REGRESSION DETECTED! Run failed to meet baselines.`);
    process.exit(1);
  } else {
    console.log(`\n✅ ALL BASELINES MET! No regression detected.`);
  }
}

runAudit().catch((err) => {
  console.error("Audit script failed:", err);
  process.exit(1);
});
