import { Storage } from "../src/storage/storage.js";
import { logger } from "../src/logger.js";

async function main() {
  const dbPath = "data/scrape2lead.db";
  const storage = new Storage(dbPath);

  const total = storage.db.prepare("SELECT COUNT(*) as c FROM leads").get() as { c: number };
  logger.info(`Total leads in DB: ${total.c}`);

  const needsEnrichment = storage.db.prepare(`
    SELECT COUNT(*) as c FROM leads 
    WHERE crm_status = 'Needs enrichment'
      AND (phone_status != 'valid' OR address_status != 'valid' OR website_status != 'valid')
  `).get() as { c: number };
  logger.info(`Leads needing enrichment: ${needsEnrichment.c}`);

  if (needsEnrichment.c === 0) {
    logger.info("No suitable leads found. Creating seed data...");
    
    const seedLeads = [
      {
        source: "2gis",
        external_id: "seed-almaty-1",
        lead_id: "SEED-ALMATY-1",
        company_name: "СтройМир Алматы",
        category: "Стройматериалы",
        city: "Алматы",
        address: "пр. Абая, 100",
        phones: JSON.stringify(["+77011111111"]),
        email: null,
        website: null,
        social_links: JSON.stringify([]),
        messenger_links: JSON.stringify([]),
        parsed_at: new Date().toISOString(),
        incomplete: 0,
        crm_status: "Needs enrichment",
        phone_status: "invalid",
        address_status: "valid",
        website_status: "empty"
      },
      {
        source: "2gis",
        external_id: "seed-almaty-2",
        lead_id: "SEED-ALMATY-2",
        company_name: "ТОО КазСтройСервис",
        category: "Ремонт квартир",
        city: "Алматы",
        address: "ул. Сатпаева, 50",
        phones: JSON.stringify(["87012222222"]),
        email: null,
        website: "http://kazstroyservis.kz",
        social_links: JSON.stringify([]),
        messenger_links: JSON.stringify([]),
        parsed_at: new Date().toISOString(),
        incomplete: 0,
        crm_status: "Needs enrichment",
        phone_status: "invalid",
        address_status: "valid",
        website_status: "valid"
      },
      {
        source: "2gis",
        external_id: "seed-almaty-3",
        lead_id: "SEED-ALMATY-3",
        company_name: "Магазин Краска и Обои",
        category: "Стройматериалы",
        city: "Алматы",
        address: "мкр. Орбита, 3",
        phones: JSON.stringify([]),
        email: null,
        website: null,
        social_links: JSON.stringify([]),
        messenger_links: JSON.stringify([]),
        parsed_at: new Date().toISOString(),
        incomplete: 0,
        crm_status: "Needs enrichment",
        phone_status: "empty",
        address_status: "valid",
        website_status: "empty"
      }
    ];

    const insertStmt = storage.db.prepare(`
      INSERT INTO leads (
        source, external_id, lead_id, company_name, category, city, address, phones,
        email, website, social_links, messenger_links, parsed_at, incomplete,
        crm_status, phone_status, address_status, website_status
      ) VALUES (
        @source, @external_id, @lead_id, @company_name, @category, @city, @address, @phones,
        @email, @website, @social_links, @messenger_links, @parsed_at, @incomplete,
        @crm_status, @phone_status, @address_status, @website_status
      ) ON CONFLICT(source, external_id) DO UPDATE SET
        lead_id = excluded.lead_id,
        crm_status = excluded.crm_status,
        phone_status = excluded.phone_status,
        address_status = excluded.address_status,
        website_status = excluded.website_status
    `);

    const txn = storage.db.transaction((leads: any[]) => {
      for (const lead of leads) {
        insertStmt.run(lead);
      }
    });

    txn(seedLeads);
    logger.info("Seed data created successfully.");
  } else {
    logger.info("Suitable leads already exist.");
  }

  storage.close();
}

main().catch(console.error);
