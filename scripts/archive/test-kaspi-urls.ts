import { chromium } from 'playwright';

async function testKaspiUrls() {
  const browser = await chromium.launch({ headless: false }); // Откроем браузер, чтобы увидеть, что происходит
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  const merchantId = "2207134711";
  
  // Точный URL, который вы указали как рабочий
  const targetUrl = `https://kaspi.kz/shop/info/merchant/${merchantId}/reviews/`;
  
  console.log(`Opening: ${targetUrl}`);
  
  try {
    const response = await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });
    const status = response?.status() ?? 0;
    const title = await page.title();
    
    console.log(`Status: ${status}`);
    console.log(`Title: "${title}"`);
    
    // Попробуем найти название магазина на странице
    const shopName = await page.locator('h1, .shop-name, .title').first().textContent().catch(() => null);
    console.log(`Found shop name: "${shopName}"`);
    
    // Подождем 5 секунд, чтобы вы могли визуально оценить страницу, если она откроется
    await page.waitForTimeout(5000);
  } catch (e) {
    console.log(`Error: ${(e as Error).message}`);
  }

  await browser.close();
}

testKaspiUrls().catch(console.error);
