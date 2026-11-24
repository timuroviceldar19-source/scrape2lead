import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { parseGateConfig, variantOf } from "../../src/bitrix/salesPult/gate/config.js";
import { clearJwksCache } from "../../src/bitrix/salesPult/gate/accessJwt.js";
import { handleGateRequest } from "../../src/bitrix/salesPult/gate/handler.js";
import { buildRtoPulse, type PulseView } from "../../src/bitrix/salesPult/pulse.js";
import { buildRtoVariant, renderRtoVariant } from "../../src/bitrix/salesPult/variants/rto.js";
import { renderFinanceHtml, renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { deployPultVariants } from "../../scripts/pult-variants.mjs";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";

// Все почты, ключи и данные в файле выдуманные.

const TEAM = "example-team";
const AUD = "c".repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const NOW = 1_800_000_000_000;

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function signJwt(email: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  ) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: ISS, aud: [AUD], email, iat: NOW / 1000 - 60, nbf: NOW / 1000 - 60, exp: NOW / 1000 + 3600
  }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  const token = `${head}.${body}.${b64url(sig)}`;
  const fetchFn = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  return { token, fetchFn };
}

function samplePulse(): PulseView {
  return {
    asOf: "2026-11-24",
    items: [
      { key: "cash-gap", severity: "red", area: "cash", title: "Кассовый разрыв", value: "не хватает 5,0 млн ₸", href: "./fin.html#f-payments", finance: true, amount: 5_000_000 },
      { key: "debt-60", severity: "red", area: "debt", title: "Долги старше 60 дней", value: "3,0 млн ₸", href: "./fin.html#f-debtors", finance: true, amount: 3_000_000 },
      { key: "stock-stagnant", severity: "yellow", area: "stock", title: "Склад без движения", value: "2,0 млн ₸", href: "./fin.html#f-stock", finance: true, amount: 2_000_000 },
      { key: "margin-below-cost", severity: "red", area: "margin", title: "Продажи ниже себестоимости", value: "убыток 100 тыс ₸", href: "./reg.html#r-risks", finance: true, amount: 100_000 },
      { key: "margin-low", severity: "yellow", area: "margin", title: "Маржа ниже 10%", value: "выручка 1,0 млн ₸", href: "./reg.html#r-risks", finance: true, amount: 1_000_000 },
      { key: "losses-cheaper", severity: "red", area: "losses", title: "Отклонены при цене ниже победителя", value: "2 заявки", href: "#competitors-ip", finance: true, amount: 4_000_000 },
      { key: "tender-today-ip", severity: "yellow", area: "tender", title: "Подать сегодня · ИП", value: "1 лот · 10,0 млн ₸", href: "#radar-ip", finance: false, amount: 10_000_000 },
      { key: "crm-errors", severity: "yellow", area: "crm", title: "Ошибки в CRM", value: "2 сделки", href: "#signals", finance: false, amount: 0 }
    ],
    missing: ["Финансы: отчёт на 17.11", "Реестр: данные на 20.11", "Радар: не загружен"],
    more: 2
  };
}

describe("роль РТО (тендеры, планы, рынок, конкуренты — без «Финансов» и «Выручки»)", () => {
  it("принимает роль rto в PULT_ROLES и отдаёт вариант rto", () => {
    const config = parseGateConfig(JSON.stringify({
      team: TEAM, aud: AUD,
      users: { "boss@example.test": "all", "rop@example.test": "rop", "rto@example.test": "rto" }
    }))!;
    expect(config.users["rto@example.test"]).toEqual({ kind: "rto" });
    expect(variantOf({ kind: "rto" })).toBe("rto");
  });

  it("вырезает пункты «Финансов» и «Выручки» из пульса РТО, оставляя тендеры, CRM и конкурентов", () => {
    const filtered = buildRtoPulse(samplePulse())!;
    expect(filtered.items.map((x) => x.key)).toEqual([
      "losses-cheaper",
      "tender-today-ip",
      "crm-errors"
    ]);
    expect(filtered.items.some((x) => x.href.startsWith("./fin.html") || x.href.startsWith("./reg.html"))).toBe(false);
    expect(filtered.missing).toEqual(["Радар: не загружен"]);
    expect(filtered.more).toBeUndefined();
  });

  it("deployPultVariants собирает _r/rto/index.html и market, но НЕ reg.html и НЕ fin.html; gate закрывает /reg и /fin для РТО", async () => {
    const f = fixture();
    f.payload.pulse = samplePulse();
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: "https://example.invalid", register: f.register };
    const report = parseFinanceWorkbook(financeWorkbook());
    const finHtml = renderFinanceHtml({ asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, finance: { report, snapshots: [financeSnapshot(report)] } });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pult-rto-"));
    const src = path.join(tmp, "src");
    const out = path.join(tmp, "out");
    const cfgPath = path.join(tmp, "config.json");
    fs.mkdirSync(path.join(src, "market", "ip"), { recursive: true });
    fs.writeFileSync(path.join(src, "index.html"), renderPultHtml(f.payload));
    fs.writeFileSync(path.join(src, "reg.html"), renderRegisterHtml(reg));
    fs.writeFileSync(path.join(src, "fin.html"), finHtml);
    fs.writeFileSync(path.join(src, "payload.json"), JSON.stringify(f.payload));
    fs.writeFileSync(path.join(src, "payload-reg.json"), JSON.stringify(reg));
    fs.writeFileSync(path.join(src, "market", "ip", "2026-11.json"), JSON.stringify({ ok: true }));

    const config = parseGateConfig(JSON.stringify({
      team: TEAM, aud: AUD,
      users: { "boss@example.test": "all", "rto@example.test": "rto" }
    }))!;
    fs.writeFileSync(cfgPath, JSON.stringify(config));

    const built = deployPultVariants(src, out, cfgPath);
    expect(built).toEqual(["all", "rto"]);
    expect(fs.existsSync(path.join(out, "_r", "rto", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(out, "_r", "rto", "reg.html"))).toBe(false);
    expect(fs.existsSync(path.join(out, "_r", "rto", "fin.html"))).toBe(false);
    expect(fs.existsSync(path.join(out, "_r", "rto", "market", "ip", "2026-11.json"))).toBe(true);

    const rtoIndex = fs.readFileSync(path.join(out, "_r", "rto", "index.html"), "utf8");
    expect(rtoIndex).not.toContain("Кассовый разрыв");
    expect(rtoIndex).not.toContain("Продажи ниже себестоимости");
    expect(rtoIndex).not.toContain("./fin.html#");
    expect(rtoIndex).not.toContain("./reg.html#");

    const assets = {
      fetch: async (input: Request | string | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const rel = url.pathname.replace(/^\/+/, "");
        const candidates = url.pathname.endsWith("/") ? [path.join(out, rel, "index.html")] : [path.join(out, rel), path.join(out, `${rel}.html`)];
        for (const file of candidates) {
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            const type = file.endsWith(".json") ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
            return new Response(fs.readFileSync(file, "utf8"), { status: 200, headers: { "content-type": type } });
          }
        }
        return new Response("not found", { status: 404 });
      }
    };

    clearJwksCache();
    const { token, fetchFn } = await signJwt("rto@example.test");
    const ask = (p: string) => handleGateRequest(new Request(`https://pult.example.test${p}`, { headers: { "Cf-Access-Jwt-Assertion": token } }), { config, assets, fetchFn, now: () => NOW });

    expect((await ask("/")).status).toBe(200);
    expect((await ask("/market/ip/2026-11.json")).status).toBe(200);
    for (const blocked of ["/fin", "/fin.html", "/reg", "/reg.html"]) {
      const res = await ask(blocked);
      expect(res.status, blocked).toBe(403);
      expect(await res.text()).toContain("Эта страница вам недоступна");
    }
  });

  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function open(html: string, width: number): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(html);
    return { page, errors };
  }

  for (const width of [1440, 375]) {
    it(`в браузере РТО видит 5 вкладок (без «Выручки» и «Финансов») и чистый пульс на ${width}px`, async () => {
      const f = fixture();
      f.payload.pulse = samplePulse();
      const pages = renderRtoVariant(buildRtoVariant({ pult: f.payload }));

      const p = await open(pages.index, width);
      try {
        expect(await p.page.locator('a[href="./fin.html"]').count()).toBe(0);
        expect(await p.page.locator('a[href="./reg.html"]').count()).toBe(0);
        expect(await p.page.locator(".sections a").evaluateAll((es) => es.map((e) => e.textContent!.trim())))
          .toEqual(["Сегодня", "Радар", "Планы", "Рынок", "Конкуренты"]);
        expect(await p.page.locator("#meSelect").isDisabled()).toBe(false);
        const pulseText = await p.page.locator("#pulse").innerText();
        expect(pulseText).not.toContain("Кассовый разрыв");
        expect(pulseText).not.toContain("Продажи ниже себестоимости");
        expect(pulseText).toContain("Подать сегодня");
        expect(pulseText).toContain("Отклонены при цене ниже победителя");
        expect(await p.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(p.errors).toEqual([]);
      } finally { await p.page.close(); }
    }, 20000);
  }
});
