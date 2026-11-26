import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGateConfig } from "../../src/bitrix/salesPult/gate/config.js";
import { clearJwksCache } from "../../src/bitrix/salesPult/gate/accessJwt.js";
import { handleGateRequest } from "../../src/bitrix/salesPult/gate/handler.js";
import { financeSnapshot, parseFinanceWorkbook } from "../../src/bitrix/salesPult/finance/parseReport.js";
import { parseIncomeStatement } from "../../src/bitrix/salesPult/finance/incomeStatement.js";
import type { FinanceView } from "../../src/bitrix/salesPult/finance/types.js";
import { renderFinanceHtml, renderPultHtml, renderRegisterHtml, type FinancePagePayload, type RegisterPagePayload } from "../../src/bitrix/salesPult/site.js";
import { deployPultVariants } from "../../scripts/pult-variants.mjs";
import { fixture } from "../fixtures/sales-pult/contracts.js";
import { financeWorkbook } from "../fixtures/sales-pult/financeWorkbook.js";
import { incomeStatementWorkbook } from "../fixtures/sales-pult/incomeStatementWorkbook.js";

// ОПиУ с расшифровкой — только на «Финансах» полного варианта (all). Почты, ключи и данные выдуманные.

const TEAM = "example-team";
const AUD = "d".repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const NOW = 1_800_000_000_000;
const MANAGER_ID = "2345";

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function signJwt(email: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  ) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: ISS, aud: [AUD], email, iat: NOW / 1000 - 60, nbf: NOW / 1000 - 60, exp: NOW / 1000 + 3600 }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  const fetchFn = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  return { token: `${head}.${body}.${b64url(sig)}`, fetchFn };
}

/** Строки, которые есть только в ОПиУ и его расшифровке (подписи статей формы бывают и в другом тексте пульта). */
const MARKERS = [
  "Расшифровка Доходов (строка 010 ОПиУ)",
  "Покупатель 07",
  "Гимназия Тест №5",
  "Ноутбуки учебные",
  "Проценты по займу",
  "ФО Альфа 2025-2026 9 мес.xlsx",
  "\"statement\""
];

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

describe("ОПиУ: изоляция по ролям", () => {
  it("данные ОПиУ попадают только в _r/all/fin.html; у РОП, РТО, менеджера и ТВ страницы нет, вход отвечает 403", async () => {
    const f = fixture();
    // в конфиге ролей ID менеджера числовой — переименовываем выдуманного «s»
    for (const g of f.payload.groups) for (const m of g.managers) if (m.id === "s") m.id = MANAGER_ID;
    const reg: RegisterPagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, portal: "https://example.invalid", register: f.register };
    const report = parseFinanceWorkbook(financeWorkbook());
    const finance: FinanceView = {
      report,
      snapshots: [financeSnapshot(report)],
      statement: parseIncomeStatement(incomeStatementWorkbook()),
      statementFile: { id: "9", name: "ФО Альфа 2025-2026 9 мес.xlsx", uploadedAt: "2026-11-26T07:51:00Z" }
    };
    const finPayload: FinancePagePayload = { asOfDate: f.payload.asOfDate, generatedAt: f.payload.generatedAt, finance };

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pult-opiu-roles-"));
    const src = path.join(tmp, "src");
    const out = path.join(tmp, "out");
    const cfgPath = path.join(tmp, "config.json");
    fs.mkdirSync(path.join(src, "market", "ip"), { recursive: true });
    fs.writeFileSync(path.join(src, "index.html"), renderPultHtml(f.payload));
    fs.writeFileSync(path.join(src, "reg.html"), renderRegisterHtml(reg));
    fs.writeFileSync(path.join(src, "fin.html"), renderFinanceHtml(finPayload));
    fs.writeFileSync(path.join(src, "payload.json"), JSON.stringify(f.payload));
    fs.writeFileSync(path.join(src, "payload-reg.json"), JSON.stringify(reg));
    // как в сборке: payload-fin.json лежит рядом, но на сайт не выкладывается
    fs.writeFileSync(path.join(src, "payload-fin.json"), JSON.stringify(finPayload));
    fs.writeFileSync(path.join(src, "market", "ip", "2026-11.json"), JSON.stringify({ ok: true }));

    const users = {
      "boss@example.test": "all",
      "rop@example.test": "rop",
      "rto@example.test": "rto",
      "seller@example.test": `manager:${MANAGER_ID}`,
      "tv@example.test": "tv"
    };
    const config = parseGateConfig(JSON.stringify({ team: TEAM, aud: AUD, users }))!;
    fs.writeFileSync(cfgPath, JSON.stringify(config));

    const built = deployPultVariants(src, out, cfgPath);
    expect(built).toEqual(["all", "rop", "rto", `m${MANAGER_ID}`]);

    // исходный fin.html действительно содержит ОПиУ — иначе проверка ниже ничего не доказывает
    const allFin = fs.readFileSync(path.join(out, "_r", "all", "fin.html"), "utf8");
    for (const marker of MARKERS) expect(allFin, marker).toContain(marker);

    for (const file of listFiles(out)) {
      const rel = path.relative(out, file);
      if (rel === path.join("_r", "all", "fin.html")) continue;
      const body = fs.readFileSync(file, "utf8");
      for (const marker of MARKERS) expect(body.includes(marker), `${rel}: ${marker}`).toBe(false);
    }
    for (const variant of ["rop", "rto", `m${MANAGER_ID}`]) {
      // ссылку «Финансы» в меню этих видов убирает код страницы — это проверяют браузерные тесты ролей
      expect(fs.existsSync(path.join(out, "_r", variant, "fin.html")), variant).toBe(false);
    }
    expect(fs.existsSync(path.join(out, "_r", "tv"))).toBe(false);
    expect(listFiles(out).some((x) => x.endsWith("payload-fin.json"))).toBe(false);

    const assets = {
      fetch: async (input: Request | string | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const rel = url.pathname.replace(/^\/+/, "");
        const candidates = url.pathname.endsWith("/") ? [path.join(out, rel, "index.html")] : [path.join(out, rel), path.join(out, `${rel}.html`)];
        for (const file of candidates) {
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            return new Response(fs.readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
          }
        }
        return new Response("not found", { status: 404 });
      }
    };
    const ask = async (email: string, p: string) => {
      clearJwksCache();
      const { token, fetchFn } = await signJwt(email);
      return handleGateRequest(new Request(`https://pult.example.test${p}`, { headers: { "Cf-Access-Jwt-Assertion": token } }), { config, assets, fetchFn, now: () => NOW });
    };

    const boss = await ask("boss@example.test", "/fin");
    expect(boss.status).toBe(200);
    expect(await boss.text()).toContain("Расшифровка Доходов (строка 010 ОПиУ)");
    for (const email of ["rop@example.test", "rto@example.test", "seller@example.test", "tv@example.test"]) {
      for (const p of ["/fin", "/fin.html"]) {
        const res = await ask(email, p);
        expect(res.status, `${email} ${p}`).toBe(403);
        const body = await res.text();
        expect(body, `${email} ${p}`).toMatch(email === "tv@example.test" ? /ещё не готов|недоступна/ : /Эта страница вам недоступна/);
        for (const marker of MARKERS) expect(body.includes(marker), `${email} ${p}: ${marker}`).toBe(false);
      }
    }
  }, 30000);
});
