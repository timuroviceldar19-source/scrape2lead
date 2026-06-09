import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { Storage } from "../src/storage/storage.js";
import type { Lead } from "../src/types.js";

/**
 * Unit tests for the crm_status filter in `Storage.getLeadsNeedingEnrichment`.
 *
 * Two filter modes are exercised:
 *   1. Default — only `crm_status = 'Needs enrichment'`. Leads with
 *      `crm_status = 'Ready to call'` are skipped even when they are
 *      missing address/website.
 *   2. `--include-ready-to-call` — also pulls in `crm_status = 'Ready to call'`
 *      rows that still lack a valid address or website. Already-enriched
 *      rows (`enrichment_status = 'enriched'`) are still skipped to
 *      guarantee idempotency.
 */

interface TestHarness {
  storage: Storage;
  dbPath: string;
  db: Database.Database;
}

let harness: TestHarness;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-enrichfilter-"));
  const dbPath = path.join(dir, "test.db");
  const storage = new Storage(dbPath);
  const db = (storage as unknown as { db: Database.Database }).db;
  harness = { storage, dbPath, db };
});

afterEach(() => {
  harness.storage.close();
  fs.rmSync(path.dirname(harness.dbPath), { recursive: true, force: true });
});

function seedLead(overrides: Partial<Lead> & { lead_id: string }): void {
  // Insert a minimal row that satisfies the NOT NULL constraints of the
  // v1 leads schema, then patch the v7 enrichment columns on top.
  harness.db
    .prepare(
      `INSERT INTO leads (
        source, external_id, company_name, category, city, address, phones,
        social_links, messenger_links, parsed_at
      ) VALUES (
        @source, @external_id, @company_name, @category, @city, @address, @phones,
        @social_links, @messenger_links, @parsed_at
      )`
    )
    .run({
      source: "kaspi",
      external_id: overrides.lead_id,
      company_name: overrides.company_name ?? "Test Co",
      category: "Test",
      city: overrides.city ?? "Астана",
      address: "",
      phones: "[]",
      social_links: "[]",
      messenger_links: "[]",
      parsed_at: "2026-06-05T00:00:00Z"
    });
  harness.db
    .prepare(
      `UPDATE leads SET
         lead_id = @lead_id,
         lead_score = @lead_score,
         priority = @priority,
         crm_status = @crm_status,
         phone_status = @phone_status,
         address_status = @address_status,
         website_status = @website_status,
         enrichment_status = @enrichment_status
       WHERE source = 'kaspi' AND external_id = @external_id`
    )
    .run({
      external_id: overrides.lead_id,
      lead_id: overrides.lead_id,
      lead_score: overrides.lead_score ?? 0.5,
      priority: "B",
      crm_status: overrides.crm_status ?? undefined,
      phone_status: overrides.phone_status ?? undefined,
      address_status: overrides.address_status ?? undefined,
      website_status: overrides.website_status ?? undefined,
      enrichment_status: overrides.enrichment_status ?? undefined
    });
}

describe("Storage.getLeadsNeedingEnrichment — crm_status filter", () => {
  it("default mode skips Ready to call rows", async () => {
    seedLead({ lead_id: "L-NE-1", crm_status: "Needs enrichment", address_status: undefined, website_status: undefined, enrichment_status: undefined });
    seedLead({ lead_id: "L-RC-1", crm_status: "Ready to call",     address_status: undefined, website_status: undefined, enrichment_status: undefined, phone_status: "valid" });
    seedLead({ lead_id: "L-RC-2", crm_status: "Ready to contact",  address_status: "valid", website_status: "valid", enrichment_status: "enriched" });

    const leads = await harness.storage.getLeadsNeedingEnrichment(100);
    expect(leads.map((l) => l.lead_id)).toEqual(["L-NE-1"]);
  });

  it("includeReadyToCall=true pulls in Ready to call leads with missing address or website", async () => {
    seedLead({ lead_id: "L-NE-1", crm_status: "Needs enrichment", address_status: undefined, website_status: undefined, enrichment_status: undefined });
    seedLead({ lead_id: "L-RC-1", crm_status: "Ready to call",     address_status: undefined, website_status: undefined, enrichment_status: undefined, phone_status: "valid" });
    seedLead({ lead_id: "L-RC-2", crm_status: "Ready to call",     address_status: "valid", website_status: undefined, enrichment_status: undefined, phone_status: "valid" });
    seedLead({ lead_id: "L-RC-3", crm_status: "Ready to call",     address_status: "valid", website_status: "valid", enrichment_status: undefined, phone_status: "valid" });
    seedLead({ lead_id: "L-RC-4", crm_status: "Ready to contact",  address_status: "valid", website_status: "valid", enrichment_status: "enriched" });

    const leads = await harness.storage.getLeadsNeedingEnrichment(100, undefined, true);
    const ids = leads.map((l) => l.lead_id).sort();
    expect(ids).toEqual(["L-NE-1", "L-RC-1", "L-RC-2"]);
  });

  it("includeReadyToCall=true still skips already-enriched rows (idempotency)", async () => {
    seedLead({ lead_id: "L-RC-DONE", crm_status: "Ready to call",  address_status: undefined, website_status: undefined, enrichment_status: "enriched", phone_status: "valid" });
    seedLead({ lead_id: "L-RC-OPEN", crm_status: "Ready to call",  address_status: undefined, website_status: undefined, enrichment_status: undefined,      phone_status: "valid" });

    const leads = await harness.storage.getLeadsNeedingEnrichment(100, undefined, true);
    expect(leads.map((l) => l.lead_id)).toEqual(["L-RC-OPEN"]);
  });

  it("includeReadyToCall=true skips leads that already have a valid address AND website", async () => {
    seedLead({
      lead_id: "L-RC-FULL",
      crm_status: "Ready to call",
      address_status: "valid",
      website_status: "valid",
      enrichment_status: undefined,
      phone_status: "valid"
    });

    const leads = await harness.storage.getLeadsNeedingEnrichment(100, undefined, true);
    expect(leads).toEqual([]);
  });

  it("limit and city still apply in includeReadyToCall mode", async () => {
    seedLead({ lead_id: "A-1", crm_status: "Ready to call", city: "Астана",  address_status: undefined, website_status: undefined, enrichment_status: undefined, lead_score: 0.9, phone_status: "valid" });
    seedLead({ lead_id: "A-2", crm_status: "Ready to call", city: "Астана",  address_status: undefined, website_status: undefined, enrichment_status: undefined, lead_score: 0.5, phone_status: "valid" });
    seedLead({ lead_id: "B-1", crm_status: "Ready to call", city: "Алматы",  address_status: undefined, website_status: undefined, enrichment_status: undefined, lead_score: 0.8, phone_status: "valid" });

    const onlyAstana = await harness.storage.getLeadsNeedingEnrichment(100, "Астана", true);
    expect(onlyAstana.map((l) => l.lead_id)).toEqual(["A-1", "A-2"]);

    const topOne = await harness.storage.getLeadsNeedingEnrichment(1, "Астана", true);
    expect(topOne.map((l) => l.lead_id)).toEqual(["A-1"]);
  });
});
