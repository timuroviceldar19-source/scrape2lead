import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env["2GIS_API_KEY"] || process.env.TWOGIS_API_KEY;

async function main() {
  if (!API_KEY) {
    console.error("❌ API key not found in .env (2GIS_API_KEY or TWOGIS_API_KEY)");
    process.exit(1);
  }

  const url = new URL("https://catalog.api.2gis.com/3.0/items");
  // 2GIS API often prefers the city in the query or uses region_id. We'll try query with city.
  url.searchParams.append("q", "Автосервисы, Астана");
  url.searchParams.append("limit", "10");
  url.searchParams.append("fields", "items.point,items.address_name,items.rubrics,items.site,items.contact_groups");
  url.searchParams.append("key", API_KEY);

  console.log("🚀 Sending request to 2GIS Places API (limit: 10)...");
  
  try {
    const response = await fetch(url.toString());
    const data = await response.json();

    if (!response.ok || data.meta?.error) {
      console.error("❌ API Request failed:", data.meta?.error || response.statusText);
      process.exit(1);
    }

    const items = data.result?.items || [];
    console.log(`✅ Request successful. Total items returned: ${items.length}`);

    const sanitizedSample = items.map((item: any) => ({
      id: item.id,
      name: item.name,
      address_name: item.address_name,
      rubrics: item.rubrics?.map((r: any) => r.name) || [],
      point: item.point ? { lat: item.point.lat, lon: item.point.lon } : null,
      site: item.site || null,
      has_contact_groups: !!item.contact_groups,
      phones: item.contact_groups?.flatMap((cg: any) => cg.contacts?.filter((c: any) => c.type === "phone").map((c: any) => c.value)) || [],
      email: item.contact_groups?.flatMap((cg: any) => cg.contacts?.filter((c: any) => c.type === "email").map((c: any) => c.value)) || [],
      messengers: item.contact_groups?.flatMap((cg: any) => cg.contacts?.filter((c: any) => c.type === "social_network").map((c: any) => c.value)) || []
    }));

    const exportDir = "exports";
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    const exportPath = path.join(exportDir, "2gis-places-api-smoke-sanitized.json");
    fs.writeFileSync(exportPath, JSON.stringify(sanitizedSample, null, 2), "utf-8");
    console.log(`💾 Sanitized sample saved to: ${exportPath}`);

    // Summary of fields
    const hasPhones = sanitizedSample.some((i: any) => i.phones.length > 0);
    const hasEmail = sanitizedSample.some((i: any) => i.email.length > 0);
    const hasMessengers = sanitizedSample.some((i: any) => i.messengers.length > 0);
    const hasSite = sanitizedSample.some((i: any) => i.site !== null);

    console.log("\n📊 Fields Present in Response:");
    console.log(`- id: ✅`);
    console.log(`- name: ✅`);
    console.log(`- address_name: ✅`);
    console.log(`- rubrics: ✅`);
    console.log(`- point (lat/lon): ✅`);
    console.log(`- site: ${hasSite ? "✅" : "❌"} (Found in ${sanitizedSample.filter((i:any)=>i.site !== null).length} items)`);
    console.log(`- phones: ${hasPhones ? "✅" : "❌"} (Found in ${sanitizedSample.filter((i:any)=>i.phones.length>0).length} items)`);
    console.log(`- email: ${hasEmail ? "✅" : "❌"} (Found in ${sanitizedSample.filter((i:any)=>i.email.length>0).length} items)`);
    console.log(`- messengers/social: ${hasMessengers ? "✅" : "❌"} (Found in ${sanitizedSample.filter((i:any)=>i.messengers.length>0).length} items)`);

    if (hasPhones) {
      console.log("\n🎉 SUCCESS: The demo API key DOES return contact phones!");
    } else {
      console.log("\n⚠️ WARNING: No phones found in this sample. Demo key might restrict contact data.");
    }

  } catch (error) {
    console.error("❌ Failed to fetch or process API data:", error);
    process.exit(1);
  }
}

main();
