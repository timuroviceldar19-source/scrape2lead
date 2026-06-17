import "dotenv/config";
import fs from "node:fs";
import { chromium } from "playwright";
import Database from "better-sqlite3";

const DB_PATH = "data/scrape2lead-2gis.db";
const DELAY_BETWEEN_CARDS_MS = 2000;

const fingerprintPatch = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en"] });
};

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface EnrichedData {
  id: string;
  address: string;
  website: string;
  email: string;
  whatsapp: string;
  telegram: string;
  messengers: string[];
}

function extractFromPayload(item: any): EnrichedData | null {
  if (!item?.id) return null;

  const cg = item.contact_groups;
  if (!cg || !Array.isArray(cg)) return null;

  const allContacts = cg.flatMap((g: any) =>
    (g.contacts || []).map((c: any) => ({
      type: c.type,
      value: c.value || c.url || c.text || ""
    }))
  );

  const address = item.address_name || item.address?.name || "";
  const website = allContacts.find((c: any) => c.type === "website")?.value || "";
  const email = allContacts.filter((c: any) => c.type === "email").map((c: any) => c.value).join(",");
  const whatsapp = allContacts.find((c: any) => c.type === "whatsapp")?.value || "";
  const telegram = allContacts.find((c: any) => c.type === "telegram")?.value || "";

  const messengers: string[] = [];
  if (whatsapp) messengers.push("WhatsApp");
  if (telegram) messengers.push("Telegram");

  if (!address && !website && !email && messengers.length === 0) return null;

  return {
    id: String(item.id),
    address,
    website,
    email,
    whatsapp,
    telegram,
    messengers,
  };
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const leads = db.prepare(`
    SELECT external_id, company_name
    FROM leads
    WHERE source = '2gis'
    ORDER BY lead_score DESC
  `).all() as Array<{ external_id: string; company_name: string }>;

  console.log(`Enriching ${leads.length} leads`);

  const targetIds = new Set(leads.map(l => l.external_id));
  const captured = new Map<string, EnrichedData>();

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

      const items = body.result?.items || (Array.isArray(body.result) ? body.result : []);
      for (const item of items) {
        const data = extractFromPayload(item);
        if (data && targetIds.has(data.id) && !captured.has(data.id)) {
          captured.set(data.id, data);
          console.log(`    [XHR] ${data.id} | addr:${data.address ? "Y" : "N"} site:${data.website ? "Y" : "N"} email:${data.email ? "Y" : "N"} msg:${data.messengers.join(",") || "N"}`);
        }
      }
    } catch {}
  });

  console.log("Loading search page...");
  await page.goto("https://2gis.kz/astana/search/%D0%90%D0%B2%D1%82%D0%BE%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await sleep(5000);

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    if (captured.has(lead.external_id)) {
      console.log(`[${i + 1}/${leads.length}] SKIP ${lead.company_name}`);
      continue;
    }

    console.log(`[${i + 1}/${leads.length}] ${lead.company_name}`);
    const firmUrl = `https://2gis.kz/astana/firm/${lead.external_id}`;

    try {
      await page.goto(firmUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2000);

      const phoneBtn = await page.$('button:has-text("Показать телефон"), [data-testid="show-phone"]');
      if (phoneBtn) {
        await phoneBtn.click().catch(() => {});
        await sleep(1500);
      }
    } catch (e: any) {
      console.log(`  ✗ error: ${e.message.split("\n")[0]}`);
    }

    if (i < leads.length - 1) await sleep(DELAY_BETWEEN_CARDS_MS);
  }

  const updateStmt = db.prepare(`
    UPDATE leads
    SET address = @address,
        address_raw = @address,
        address_clean = @address,
        address_status = @address_status,
        website = @website,
        real_website = @website,
        website_status = @website_status,
        email = @email,
        email_raw = @email,
        email_status = @email_status,
        messenger_links = @messengers,
        messenger_flags = @messenger_flags,
        enrichment_status = 'enriched',
        enrichment_source = '2gis',
        enrichment_attempted_at = @timestamp
    WHERE external_id = @external_id
  `);

  let enriched = 0;
  const stats = { address: 0, website: 0, email: 0, messengers: 0 };

  for (const [id, data] of captured) {
    updateStmt.run({
      external_id: id,
      address: data.address || "",
      address_status: data.address ? "valid" : "empty",
      website: data.website || "",
      website_status: data.website ? "valid" : "empty",
      email: data.email || "",
      email_status: data.email ? "valid" : "empty",
      messengers: JSON.stringify(data.messengers),
      messenger_flags: data.messengers.join(","),
      timestamp: new Date().toISOString(),
    });

    enriched++;
    if (data.address) stats.address++;
    if (data.website) stats.website++;
    if (data.email) stats.email++;
    if (data.messengers.length > 0) stats.messengers++;
  }

  const finalStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN json_array_length(phones) > 0 THEN 1 ELSE 0 END) as with_phone,
      SUM(CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) as with_website,
      SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as with_email,
      SUM(CASE WHEN address IS NOT NULL AND address != '' THEN 1 ELSE 0 END) as with_address,
      SUM(CASE WHEN messenger_links IS NOT NULL AND messenger_links != '[]' AND messenger_links != '' THEN 1 ELSE 0 END) as with_messengers
    FROM leads WHERE source = '2gis'
  `).get() as any;

  console.log(`\nEnriched: ${enriched}`);
  console.log(`Added: address=${stats.address}, website=${stats.website}, email=${stats.email}, messengers=${stats.messengers}`);
  console.log(`\nFinal stats:`);
  console.log(JSON.stringify(finalStats, null, 2));

  fs.mkdirSync("exports", { recursive: true });
  fs.writeFileSync("exports/2gis-enrichment-captured.json", JSON.stringify([...captured.values()], null, 2));

  await browser.close();
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
