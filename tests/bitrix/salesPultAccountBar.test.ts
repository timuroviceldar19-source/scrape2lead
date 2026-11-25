import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { parseGateConfig } from "../../src/bitrix/salesPult/gate/config.js";
import { clearJwksCache } from "../../src/bitrix/salesPult/gate/accessJwt.js";
import { ACCOUNT_MARKER, handleGateRequest, renderAccountBar } from "../../src/bitrix/salesPult/gate/handler.js";
import { renderFinanceHtml, renderPultHtml, renderRegisterHtml, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { buildRopVariant, renderRopVariant } from "../../src/bitrix/salesPult/variants/rop.js";
import { buildRtoVariant, renderRtoVariant } from "../../src/bitrix/salesPult/variants/rto.js";
import { buildManagerVariant, renderManagerVariant } from "../../src/bitrix/salesPult/variants/manager.js";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";

// Все почты, ключи и данные в файле выдуманные.

const TEAM = "example-team";
const AUD = "d".repeat(64);
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

function makeAssets(files: Record<string, string>) {
  return {
    fetch: async (input: Request | string | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const file = url.pathname.endsWith("/") ? `${url.pathname}index.html` : `${url.pathname}.html`;
      return file in files
        ? new Response(files[file], { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("not found", { status: 404 });
    }
  };
}

describe("плашка «Вы вошли как …» и кнопка «Выйти»", () => {
  it("renderAccountBar показывает почту, подпись роли, ссылку /cdn-cgi/access/logout и экранирует спецсимволы", () => {
    const html = renderAccountBar("user+<b>$&</b>@example.test", { kind: "rop" });
    expect(html).toContain("Вы вошли как");
    expect(html).toContain("user+&lt;b&gt;$&amp;&lt;/b&gt;@example.test");
    expect(html).toContain("РОП");
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    expect(html).toContain("Выйти");
    expect(renderAccountBar("a@example.test", { kind: "all" })).toContain("полный доступ");
    expect(renderAccountBar("b@example.test", { kind: "rto" })).toContain("РТО");
    expect(renderAccountBar("c@example.test", { kind: "manager", managerId: "1" })).toContain("менеджер");
  });

  it("gate подставляет «Вы вошли как» и «Выйти» на главную, Выручку и Финансы для каждой роли и не ломает спецсимволы $&", async () => {
    const f = fixture();
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: "https://example.invalid", register: f.register };
    const report = parseFinanceWorkbook(financeWorkbook());
    const fin = renderFinanceHtml({ asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, finance: { report, snapshots: [financeSnapshot(report)] } });

    const ropPages = renderRopVariant(buildRopVariant({ pult: f.payload, reg }));
    const rtoPages = renderRtoVariant(buildRtoVariant({ pult: f.payload }));
    const mgrPages = renderManagerVariant(buildManagerVariant({ pult: f.payload, reg, planDeals: [], managerId: "s", aliases: f.aliases })!);

    const allIndex = renderPultHtml(f.payload);
    const allReg = renderRegisterHtml(reg);
    expect(allIndex).toContain(ACCOUNT_MARKER);
    expect(allReg).toContain(ACCOUNT_MARKER);
    expect(fin).toContain(ACCOUNT_MARKER);

    const files: Record<string, string> = {
      "/_r/all/index.html": allIndex,
      "/_r/all/reg.html": allReg,
      "/_r/all/fin.html": fin,
      "/_r/rop/index.html": ropPages.index,
      "/_r/rop/reg.html": ropPages.reg,
      "/_r/rto/index.html": rtoPages.index,
      "/_r/m101/index.html": mgrPages.index,
      "/_r/m101/reg.html": mgrPages.reg
    };
    const config = parseGateConfig(JSON.stringify({
      team: TEAM, aud: AUD,
      users: {
        "boss$&@example.test": "all",
        "rop@example.test": "rop",
        "rto@example.test": "rto",
        "seller@example.test": "manager:101"
      }
    }))!;

    async function get(email: string, pathname: string, method: "GET" | "HEAD" = "GET") {
      clearJwksCache();
      const { token, fetchFn } = await signJwt(email);
      return handleGateRequest(
        new Request(`https://pult.example.test${pathname}`, { method, headers: { "Cf-Access-Jwt-Assertion": token } }),
        { config, assets: makeAssets(files), fetchFn, now: () => NOW }
      );
    }

    for (const pathname of ["/", "/reg", "/fin"]) {
      const res = await get("boss$&@example.test", pathname);
      expect(res.status, pathname).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(ACCOUNT_MARKER);
      expect(html).toContain("Вы вошли как <b>boss$&amp;@example.test</b>");
      expect(html).toContain("полный доступ");
      expect(html).toContain('href="/cdn-cgi/access/logout"');
    }

    const headRes = await get("rop@example.test", "/", "HEAD");
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");

    const ropHtml = await (await get("rop@example.test", "/reg")).text();
    expect(ropHtml).toContain("Вы вошли как <b>rop@example.test</b>");
    expect(ropHtml).toContain("РОП");

    const rtoHtml = await (await get("rto@example.test", "/")).text();
    expect(rtoHtml).toContain("Вы вошли как <b>rto@example.test</b>");
    expect(rtoHtml).toContain("РТО");

    const mgrHtml = await (await get("seller@example.test", "/")).text();
    expect(mgrHtml).toContain("Вы вошли как <b>seller@example.test</b>");
    expect(mgrHtml).toContain("менеджер");
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
    it(`в браузере плашка аккаунта и кнопка «Выйти» видны без переполнения и скрываются в ТВ-режиме на ${width}px`, async () => {
      const f = fixture();
      const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: "https://example.invalid", register: f.register };
      const report = parseFinanceWorkbook(financeWorkbook());
      const fin = renderFinanceHtml({ asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, finance: { report, snapshots: [financeSnapshot(report)] } });

      const barHtml = renderAccountBar("long.manager.address@company.example.test", { kind: "rop" });
      const pages = [
        ["index", renderPultHtml(f.payload).replace(ACCOUNT_MARKER, () => barHtml)],
        ["reg", renderRegisterHtml(reg).replace(ACCOUNT_MARKER, () => barHtml)],
        ["fin", fin.replace(ACCOUNT_MARKER, () => barHtml)]
      ] as const;

      for (const [name, html] of pages) {
        const { page, errors } = await open(html, width);
        try {
          const bar = page.locator(".account-bar");
          expect(await bar.isVisible(), name).toBe(true);
          expect((await bar.innerText()).replace(/\s+/g, " ")).toContain("Вы вошли как long.manager.address@company.example.test");
          expect(await bar.locator('a[href="/cdn-cgi/access/logout"]').innerText()).toBe("Выйти");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
          if (name === "index" && width === 1440) {
            await page.locator("#tvBtn").click();
            expect(await bar.isVisible()).toBe(false);
          }
          expect(errors, name).toEqual([]);
        } finally { await page.close(); }
      }
    }, 25000);
  }
});
