import "dotenv/config";
import fs from "node:fs";
import { chromium } from "playwright";
import Database from "better-sqlite3";

const DB_PATH = "data/scrape2lead-2gis.db";
const DELAY_AFTER_CLICK_MS = 2000;
const SCROLL_DELAY_MS = 1500;

interface CapturedContact {
  id: string;
  name: string;
  address: string;
  rubrics: string[];
  rating: number | null;
  review_count: number | null;
  phones: string[];
  website: string;
  whatsapp: string;
  telegram: string;
  email: string[];
  messengers: string[];
}

function extractContactsFromItem(item: any): CapturedContact | null {
  if (!item?.id) return null;
  const contactGroups = item.contact_groups;
  if (!contactGroups || !Array.isArray(contactGroups)) return null;

  const allContacts = contactGroups.flatMap((g: any) =>
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
    rubrics: (item.rubrics || []).map((r: any) => r.name),
    rating: item.reviews?.rating || null,
    review_count: item.reviews?.review_count || null,
    phones,
    website: allContacts.find((c: any) => c.type === "website")?.value || "",
    whatsapp: allContacts.find((c: any) => c.type === "whatsapp")?.value || "",
    telegram: allContacts.find((c: any) => c.type === "telegram")?.value || "",
    email: allContacts.filter((c: any) => c.type === "email").map((c: any) => c.value),
    messengers: allContacts
      .filter((c: any) => ["whatsapp", "telegram", "viber"].includes(c.type))
      .map((c: any) => c.type.charAt(0).toUpperCase() + c.type.slice(1)),
  };
}

function flattenItems(payload: any): any[] {
  const items: any[] = [];
  if (!payload) return items;
  if (payload.result?.items) {
    items.push(...payload.result.items);
  }
  if (Array.isArray(payload.result)) {
    items.push(...payload.result);
  }
  return items;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  console.log(`Target IDs to enrich: ${targetIds.size}`);

  const captured = new Map<string, CapturedContact>();

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 }
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
          console.log(`  [CAPTURED] ${contact.name} | phones: ${contact.phones.join(",")}`);
        }
      }
    } catch {}
  });

  console.log("Loading search page...");
  await page.goto("https://2gis.kz/astana/search/%D0%90%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await sleep(3000);

  console.log("Opening individual firm cards...");
  const remaining = [...targetIds].filter(id => !captured.has(id));
  console.log(`Remaining: ${remaining.length}`);

  for (let i = 0; i < remaining.length; i++) {
    const firmId = remaining[i];
    const firmUrl = `https://2gis.kz/astana/firm/${firmId}`;
    console.log(`  [${i + 1}/${remaining.length}] Opening ${firmUrl}`);

      try {
        await page.goto(firmUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await sleep(DELAY_AFTER_CLICK_MS);

        await page.evaluate(() => {
          const btn = document.querySelector('[class*="showPhone"], [class*="phone"] button, button[class*="phone"]');
          if (btn) (btn as HTMLElement).click();
        });
        await sleep(1500);
      } catch (e: any) {
        console.log(`    Navigation error: ${e.message}`);
      }

      if (captured.has(firmId)) {
        console.log(`    Got it!`);
      }
    }

  console.log(`\nTotal captured: ${captured.size}`);

  const updateStmt = db.prepare(`
    UPDATE leads
    SET phones = @phones,
        website = @website,
        messenger_links = @messengers,
        phone_raw = @phone_raw,
        phone_normalized = @phone_normalized,
        phone_status = @phone_status,
        email_raw = @email_raw,
        email_status = @email_status,
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
      email_raw: contact.email[0] || "",
      email_status: contact.email.length > 0 ? "valid" : "empty",
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
  console.log(`Total 2GIS leads: ${stats.total}`);
  console.log(`With phone: ${stats.with_phone}`);
  console.log(`Ready to call: ${stats.ready_to_call}`);

  const exportPath = "exports/2gis-xhr-captured.json";
  fs.mkdirSync("exports", { recursive: true });
  fs.writeFileSync(exportPath, JSON.stringify([...captured.values()], null, 2));
  console.log(`Raw data saved: ${exportPath}`);

  await browser.close();
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
