import "dotenv/config";
import fs from "node:fs";
import { chromium } from "playwright";
import Database from "better-sqlite3";

const DB_PATH = "data/scrape2lead-2gis.db";
const DELAY_BETWEEN_CARDS_MS = 2500;

const fingerprintPatch = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en"] });
  Object.defineProperty(navigator, "plugins", {
    get: () => [
      { name: "Chrome PDF Plugin" },
      { name: "Chrome PDF Viewer" },
      { name: "Native Client" }
    ]
  });
};

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface CapturedContact {
  id: string;
  name: string;
  address: string;
  phones: string[];
  website: string;
  whatsapp: string;
  messengers: string[];
}

function extractContactsFromItem(item: any): CapturedContact | null {
  if (!item?.id) return null;
  const cg = item.contact_groups;
  if (!cg || !Array.isArray(cg)) return null;

  const allContacts = cg.flatMap((g: any) =>
    (g.contacts || []).map((c: any) => ({
      type: c.type,
      value: c.value || c.url || c.text || ""
    }))
  );

  const phones = allContacts.filter((c: any) => c.type === "phone").map((c: any) => c.value);
  if (phones.length === 0) return null;

  const nameEx = item.name_ex;
  const name = nameEx
    ? `${nameEx.primary || ""}${nameEx.extension ? ", " + nameEx.extension : ""}`
    : (item.name || "");

  return {
    id: String(item.id),
    name,
    address: item.address_name || "",
    phones,
    website: allContacts.find((c: any) => c.type === "website")?.value || "",
    whatsapp: allContacts.find((c: any) => c.type === "whatsapp")?.value || "",
    messengers: allContacts
      .filter((c: any) => ["whatsapp", "telegram", "viber"].includes(c.type))
      .map((c: any) => c.type.charAt(0).toUpperCase() + c.type.slice(1)),
  };
}

function flattenItems(payload: any): any[] {
  if (!payload) return [];
  if (payload.result?.items) return payload.result.items;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const noPhoneLeads = db.prepare(`
    SELECT external_id, company_name
    FROM leads
    WHERE source = '2gis'
      AND (json_array_length(phones) = 0 OR phones = '[]')
    ORDER BY lead_score DESC
  `).all() as Array<{ external_id: string; company_name: string }>;

  console.log(`Leads without phone: ${noPhoneLeads.length}`);

  const targetIds = new Set(noPhoneLeads.map(l => l.external_id));
  const captured = new Map<string, CapturedContact>();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 }
  });

  await context.addInitScript(fingerprintPatch);
  await context.addInitScript(() => {
    (globalThis as any).__name = (target: any, value: string) => {
      try { Object.defineProperty(target, "name", { value, configurable: true }); } catch {}
      return target;
    };
  });

  const page = await context.newPage();

  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("catalog.api.2gis")) return;
    if (response.status() !== 200) return;
    try {
      const body = await response.json().catch(() => null);
      if (!body) return;
      for (const item of flattenItems(body)) {
        const contact = extractContactsFromItem(item);
        if (contact && targetIds.has(contact.id) && !captured.has(contact.id)) {
          captured.set(contact.id, contact);
          console.log(`    [XHR] ${contact.name} | phones: ${contact.phones.join(",")}`);
        }
      }
    } catch {}
  });

  console.log("Loading 2gis.kz/astana...");
  await page.goto("https://2gis.kz/astana", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(5000);

  for (let i = 0; i < noPhoneLeads.length; i++) {
    const lead = noPhoneLeads[i];
    if (captured.has(lead.external_id)) {
      console.log(`[${i + 1}/${noPhoneLeads.length}] SKIP (already captured) ${lead.company_name}`);
      continue;
    }

    console.log(`[${i + 1}/${noPhoneLeads.length}] ${lead.company_name}`);
    const firmUrl = `https://2gis.kz/astana/firm/${lead.external_id}`;

    try {
      await page.goto(firmUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3000);

      const phoneBtn = await page.$('button:has-text("Показать телефон"), [data-testid="show-phone"], [class*="showPhone"]');
      if (phoneBtn) {
        await phoneBtn.click().catch(() => {});
        await sleep(2000);
      }

      const domPhones = await page.$$eval('a[href^="tel:"]', (els: any[]) =>
        els.map(el => el.getAttribute("href")?.replace("tel:", "")).filter(Boolean)
      );

      if (domPhones.length > 0 && !captured.has(lead.external_id)) {
        captured.set(lead.external_id, {
          id: lead.external_id,
          name: lead.company_name,
          address: "",
          phones: domPhones,
          website: "",
          whatsapp: "",
          messengers: [],
        });
        console.log(`    [DOM] phones: ${domPhones.join(", ")}`);
      }
    } catch (e: any) {
      console.log(`    error: ${e.message.split("\n")[0]}`);
    }

    if (i < noPhoneLeads.length - 1) await sleep(DELAY_BETWEEN_CARDS_MS);
  }

  const updateStmt = db.prepare(`
    UPDATE leads
    SET phones = @phones,
        website = @website,
        messenger_links = @messengers,
        phone_raw = @phone_raw,
        phone_normalized = @phone_normalized,
        phone_status = @phone_status,
        real_website = @real_website,
        website_status = @website_status,
        messenger_flags = @messenger_flags,
        contactability = @contactability,
        crm_status = @crm_status,
        next_action = @next_action,
        enrichment_status = 'enriched',
        enrichment_source = '2gis',
        enrichment_attempted_at = @timestamp
    WHERE external_id = @external_id
  `);

  let enriched = 0;
  for (const [id, contact] of captured) {
    updateStmt.run({
      external_id: id,
      phones: JSON.stringify(contact.phones),
      website: contact.website || null,
      messengers: JSON.stringify(contact.messengers),
      phone_raw: contact.phones[0],
      phone_normalized: contact.phones[0],
      phone_status: "valid",
      real_website: contact.website || "",
      website_status: contact.website ? "valid" : "empty",
      messenger_flags: contact.messengers.join(","),
      contactability: "Phone ready",
      crm_status: "Ready to call",
      next_action: "Call",
      timestamp: new Date().toISOString(),
    });
    enriched++;
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN json_array_length(phones) > 0 THEN 1 ELSE 0 END) as with_phone,
      SUM(CASE WHEN crm_status = 'Ready to call' THEN 1 ELSE 0 END) as ready_to_call
    FROM leads WHERE source = '2gis'
  `).get() as any;

  console.log(`\nEnriched: ${enriched}`);
  console.log(`Total 2GIS: ${stats.total} | With phone: ${stats.with_phone} | Ready: ${stats.ready_to_call}`);

  fs.mkdirSync("exports", { recursive: true });
  fs.writeFileSync("exports/2gis-final-captured.json", JSON.stringify([...captured.values()], null, 2));

  await browser.close();
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
