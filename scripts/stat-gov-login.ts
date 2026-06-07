import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SESSION_FILE = 'data/stat-gov-session.json';

async function login() {
  console.log('Запуск браузера для авторизации на stat.gov.kz...\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 100
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();

  console.log('Переход на stat.gov.kz...');
  await page.goto('https://stat.gov.kz/ru/cabinet/juridical/by/bin/', {
    waitUntil: 'networkidle'
  });

  console.log('\nОтсканируйте QR код в egov mobile...');
  console.log('Ожидаю авторизацию (проверка формы поиска каждые 3 сек)...\n');

  let authorized = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      const searchForm = await page.$('input[name="bin"]');
      if (searchForm) {
        authorized = true;
        break;
      }
    } catch {}

    if (i % 5 === 0 && i > 0) {
      console.log(`  Ожидание... ${i * 3} сек`);
    }
  }

  if (!authorized) {
    console.error('Таймаут: авторизация не завершена за 3 минуты');
    await browser.close();
    process.exit(1);
  }

  console.log('Авторизация подтверждена!');
  console.log('Сохранение сессии...');

  const cookies = await context.cookies();
  const storageState = await context.storageState();

  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({
    cookies,
    storageState,
    savedAt: new Date().toISOString()
  }, null, 2));

  console.log(`Сессия сохранена в ${SESSION_FILE}`);
  console.log(`Cookies: ${cookies.length}`);
  console.log(`Сохранено: ${new Date().toLocaleString('ru-RU')}`);

  await browser.close();
  console.log('\nГотово! Можно запускать collector.');
}

login().catch(err => {
  console.error('Ошибка:', err);
  process.exit(1);
});
