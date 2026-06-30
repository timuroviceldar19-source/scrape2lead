import "dotenv/config";
import { chromium } from "playwright";
import Database from "better-sqlite3";

const DB_PATH = "data/scrape2lead-2gis.db";
const API_KEY = "c7f1a769-c8a5-4636-b14d-d8c987808a12";
const DELAY_MS = 2500;

const FIELDS = "items.contact_groups,items.name_ex,items.address_name,items.rubrics,items.point,items.org,items.site,items.schedule,items.reviews";

async function fetchContactsInPage(page: any, firmId: string): Promise<any> {
  return await page.evaluate(async ({ id, key, fields }: { id: string; key: string; fields: string }) => {
    const url = `https://catalog.api.2gis.ru/3.0/items/byid?id=${id}&key=${key}&fields=${fields}`;
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.meta?.error) return { error: data.meta.error.message, type: data.meta.error.type };
      const item = data.result?.items?.[0];
      if (!item) return { error: "no item" };

      const contacts = (item.contact_groups || []).flatMap((g: any) =>
        (g.contacts || []).map((c: any) => ({ type: c.type, value: c.value || c.url || c.text }))
      );

      return {
        id: item.id,
        name: item.name_ex ? `${item.name_ex.primary}${item.name_ex.extension ? ", " + item.name_ex.extension : ""}` : item.name,
        address: item.address_name || "",
        rubrics: (item.rubrics || []).map((r: any) => r.name),
        rating: item.reviews?.rating || null,
        review_count: item.reviews?.review_count || null,
        contacts,
        phones: contacts.filter((c: any) => c.type === "phone").map((c: any) => c.value),
        website: contacts.find((c: any) => c.type === "website")?.value || "",
        whatsapp: contacts.find((c: any) => c.type === "whatsapp")?.value || "",
        telegram: contacts.find((c: any) => c.type === "telegram")?.value || "",
        email: contacts.filter((c: any) => c.type === "email").map((c: any) => c.value),
      };
    } catch (e: any) {
      return { error: e.message };
    }
  }, { id: firmId, key: API_KEY, fields: FIELDS });
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

  console.log(`Found ${noPhoneLeads.length} leads without phones`);

  if (noPhoneLeads.length === 0) {
    console.log("Nothing to enrich");
    process.exit(0);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "ru-RU",
    timezoneId: "Asia/Almaty",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();

  console.log("Loading 2gis.kz/astana...");
  await page.goto("https://2gis.kz/astana", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);

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
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < noPhoneLeads.length; i++) {
    const lead = noPhoneLeads[i];
    console.log(`[${i + 1}/${noPhoneLeads.length}] ${lead.company_name} (${lead.external_id})`);

    const result = await fetchContactsInPage(page, lead.external_id);

    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
      failed++;
      errors.push(`${lead.external_id}: ${result.error}`);
    } else if (result.phones.length > 0) {
      const messengers: string[] = [];
      if (result.whatsapp) messengers.push("WhatsApp");
      if (result.telegram) messengers.push("Telegram");

      updateStmt.run({
        external_id: lead.external_id,
        phones: JSON.stringify(result.phones),
        website: result.website || null,
        messengers: JSON.stringify(messengers),
        phone_raw: result.phones[0],
        phone_normalized: result.phones[0],
        phone_status: "valid",
        email_raw: result.email[0] || "",
        email_status: result.email.length > 0 ? "valid" : "empty",
        real_website: result.website || "",
        website_status: result.website ? "valid" : "empty",
        messenger_flags: messengers.join(","),
        contactability: "Phone ready",
        crm_status: "Ready to call",
        next_action: "Call",
        timestamp: new Date().toISOString(),
      });

      enriched++;
      console.log(`  OK: phones=${result.phones.join(",")}, website=${result.website}`);
    } else {
      console.log(`  No contacts found`);
      failed++;
    }

    if (i < noPhoneLeads.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone: ${enriched} enriched, ${failed} failed`);
  if (errors.length > 0) {
    console.log("Errors:", errors.slice(0, 10));
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN json_array_length(phones) > 0 THEN 1 ELSE 0 END) as with_phone,
      SUM(CASE WHEN crm_status = 'Ready to call' THEN 1 ELSE 0 END) as ready_to_call
    FROM leads
    WHERE source = '2gis'
  `).get() as any;

  console.log(`\nFinal stats:`);
  console.log(`  Total 2GIS leads: ${stats.total}`);
  console.log(`  With phone: ${stats.with_phone}`);
  console.log(`  Ready to call: ${stats.ready_to_call}`);

  await browser.close();
  db.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
