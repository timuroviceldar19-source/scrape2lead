import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, "../exports/sales-pult/index.html").replace(/\\/g, "/");
const outDir = path.resolve(__dirname, "../exports/sales-pult/screenshots").replace(/\\/g, "/");

const b = await chromium.launch();

async function run(name, w, h, q, fn, scale) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale || 1 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (msg) => {
    if (msg.type() === "error") errs.push(msg.text());
  });

  await p.goto("file:///" + htmlPath + q);
  await p.waitForTimeout(500);

  if (!q.includes("tv=1")) {
    for (let y = 0; y < 12000; y += 400) {
      await p.evaluate((yy) => window.scrollTo(0, yy), y);
      await p.waitForTimeout(60);
    }
    await p.evaluate(() => window.scrollTo(0, 0));
  }
  await p.waitForTimeout(2000);
  if (fn) await fn(p);
  await p.waitForTimeout(600);
  const outPath = outDir + "/" + name + ".png";
  await p.screenshot({ path: outPath });
  console.log(name, errs.length ? "ERR " + errs.join(" | ") : "ok", "->", outPath);
  await p.close();
}

const to = (sel, off = 70) => async (p) =>
  p.evaluate(([s, o]) => window.scrollTo(0, document.querySelector(s).getBoundingClientRect().top + window.scrollY - o), [sel, off]);

await run("1-главный-экран", 1440, 900, "?demo=day");
await run("2-отдел-продаж", 1440, 900, "?demo=day", to("#sales"));
await run("3-звонки", 1440, 900, "?demo=day", to("#calls"));
await run("4-карточка-менеджера", 1440, 900, "?demo=day", async (p) => {
  await to("#sales")(p);
  await p.locator("#sales .trow.body").nth(1).click();
  await p.waitForTimeout(700);
  await to("#sales .trow.body[aria-expanded=true]", 140)(p);
});
await run("5-утро-реальные-данные", 1440, 900, "", to("#sales"));
await run("6-телефон", 390, 844, "?demo=day", null, 2);
await run("7-режим-ТВ", 1920, 1080, "?demo=day&tv=1");

await b.close();
console.log("All screenshots captured successfully.");
