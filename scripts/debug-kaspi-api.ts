import { chromium } from 'playwright';

async function debugKaspiApi() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const url = "https://kaspi.kz/yml/product-view/pl/filters?q=%3AavailableInZones%3AMagnum_ZONE1&sort=relevance&text=%D0%A1%D1%82%D1%80%D0%BE%D0%B9%D0%BC%D0%B0%D1%82%D0%B5%D1%80%D0%B8%D0%B0%D0%BB%D1%8B&sc=&ui=m&filteredByCategory=false";
  console.log("Fetching:", url);
  
  const response = await page.request.get(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://kaspi.kz/'
    }
  });
  
  if (response.ok()) {
    const data = await response.json();
    const filters = data?.data?.filters;
    if (Array.isArray(filters)) {
      const allMerchants = filters.find((f: any) => f.id === "allMerchants");
      if (allMerchants && Array.isArray(allMerchants.rows)) {
        console.log("\n--- First 3 merchants from API ---");
        for (let i = 0; i < Math.min(3, allMerchants.rows.length); i++) {
          const m = allMerchants.rows[i];
          console.log(`\nMerchant ${i + 1}:`);
          console.log("Keys:", Object.keys(m));
          console.log("id:", m.id);
          console.log("name:", m.name);
          console.log("title:", m.title);
          console.log("rating:", m.rating);
          console.log("reviews:", m.reviews);
          console.log("Full object:", JSON.stringify(m, null, 2));
        }
      } else {
        console.log("Could not find allMerchants filter or rows.");
        console.log("Available filter IDs:", filters.map((f: any) => f.id));
      }
    } else {
      console.log("No filters array found in data.");
      console.log("Top level keys:", Object.keys(data));
    }
  } else {
    console.log("Failed to fetch:", response.status(), response.statusText());
  }
  
  await browser.close();
}

debugKaspiApi().catch(console.error);
