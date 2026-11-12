import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseGateConfig, variantOf } from "../../src/bitrix/salesPult/gate/config.js";
import { verifyAccessJwt, clearJwksCache } from "../../src/bitrix/salesPult/gate/accessJwt.js";
import { handleGateRequest } from "../../src/bitrix/salesPult/gate/handler.js";

// Все почты, команды и ключи этого файла выдуманные.
const TEAM = "example-team";
const AUD = "a".repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString("base64url");

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  ) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { pair, jwk };
}

async function sign(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>, alg = "RS256") {
  const head = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const now = 1_800_000_000_000;
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISS, aud: [AUD], email: "Boss@Example.test", iat: now / 1000 - 60, nbf: now / 1000 - 60, exp: now / 1000 + 3600, ...extra
});

function jwksFetch(keys: object[]) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ keys }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

describe("роли пульта: конфиг", () => {
  it("без секрета проверка выключена", () => {
    expect(parseGateConfig(undefined)).toBeNull();
    expect(parseGateConfig("")).toBeNull();
    expect(parseGateConfig("   ")).toBeNull();
  });

  it("разбирает роли и приводит почты к нижнему регистру", () => {
    const config = parseGateConfig(JSON.stringify({
      team: TEAM, aud: AUD,
      users: { " Boss@Example.test ": "all", "seller@example.test": "manager:2381", "tv@example.test": "tv" }
    }))!;
    expect(config.team).toBe(TEAM);
    expect(config.aud).toBe(AUD);
    expect(config.users).toEqual({
      "boss@example.test": { kind: "all" },
      "seller@example.test": { kind: "manager", managerId: "2381" },
      "tv@example.test": { kind: "tv" }
    });
    expect(variantOf({ kind: "all" })).toBe("all");
    expect(variantOf({ kind: "tv" })).toBe("tv");
    expect(variantOf({ kind: "manager", managerId: "2381" })).toBe("m2381");
  });

  it("падает на ошибке в секрете, а не выкладывает пульт с неверными ролями", () => {
    const base = { team: TEAM, users: { "a@example.test": "all" } };
    expect(() => parseGateConfig("{")).toThrow(/PULT_ROLES/);
    expect(() => parseGateConfig(JSON.stringify({ ...base, team: "bad team!" }))).toThrow(/team/);
    expect(() => parseGateConfig(JSON.stringify({ ...base, users: {} }))).toThrow(/users/);
    expect(() => parseGateConfig(JSON.stringify({ ...base, users: { "a@example.test": "boss" } }))).toThrow(/a@example.test/);
    expect(() => parseGateConfig(JSON.stringify({ ...base, users: { "a@example.test": "manager:abc" } }))).toThrow(/manager/);
    expect(() => parseGateConfig(JSON.stringify({ ...base, users: { "not-an-email": "all" } }))).toThrow(/not-an-email/);
    expect(() => parseGateConfig(JSON.stringify({ ...base, aud: "x y" }))).toThrow(/aud/);
  });
});

describe("роли пульта: токен Cloudflare Access", () => {
  it("принимает подписанный командой токен и отдаёт почту в нижнем регистре", async () => {
    clearJwksCache();
    const { pair, jwk } = await keyPair("k1");
    const { fn, calls } = jwksFetch([jwk]);
    const token = await sign(pair.privateKey, "k1", claims());
    expect(await verifyAccessJwt(token, { team: TEAM, aud: AUD, fetchFn: fn, now })).toEqual({ email: "boss@example.test" });
    expect(calls).toEqual([`${ISS}/cdn-cgi/access/certs`]);
    // Ключи кэшируются: второй запрос не идёт за ними снова.
    await verifyAccessJwt(token, { team: TEAM, aud: AUD, fetchFn: fn, now });
    expect(calls).toHaveLength(1);
  });

  it("отклоняет чужую аудиторию, чужого издателя, просроченный и ещё не действующий токен", async () => {
    clearJwksCache();
    const { pair, jwk } = await keyPair("k1");
    const { fn } = jwksFetch([jwk]);
    const check = async (extra: Record<string, unknown>) =>
      verifyAccessJwt(await sign(pair.privateKey, "k1", claims(extra)), { team: TEAM, aud: AUD, fetchFn: fn, now });
    expect(await check({ aud: ["b".repeat(64)] })).toBeNull();
    expect(await check({ iss: "https://other-team.cloudflareaccess.com" })).toBeNull();
    expect(await check({ exp: now / 1000 - 300 })).toBeNull();
    expect(await check({ nbf: now / 1000 + 600 })).toBeNull();
    expect(await check({ email: undefined })).toBeNull();
    // Аудитория строкой, а не массивом, тоже допустима.
    expect(await check({ aud: AUD })).toEqual({ email: "boss@example.test" });
  });

  it("без aud в конфиге проверяет подпись и издателя", async () => {
    clearJwksCache();
    const { pair, jwk } = await keyPair("k1");
    const { fn } = jwksFetch([jwk]);
    const token = await sign(pair.privateKey, "k1", claims({ aud: ["c".repeat(64)] }));
    expect(await verifyAccessJwt(token, { team: TEAM, fetchFn: fn, now })).toEqual({ email: "boss@example.test" });
  });

  it("отклоняет подпись чужим ключом, alg none и мусор", async () => {
    clearJwksCache();
    const good = await keyPair("k1");
    const evil = await keyPair("k1");
    const { fn } = jwksFetch([good.jwk]);
    const opts = { team: TEAM, aud: AUD, fetchFn: fn, now };
    expect(await verifyAccessJwt(await sign(evil.pair.privateKey, "k1", claims()), opts)).toBeNull();
    const [, body] = (await sign(good.pair.privateKey, "k1", claims())).split(".");
    expect(await verifyAccessJwt(`${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${body}.`, opts)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", opts)).toBeNull();
    expect(await verifyAccessJwt("", opts)).toBeNull();
  });

  it("при смене ключа команды один раз перечитывает ключи", async () => {
    clearJwksCache();
    const oldKey = await keyPair("old");
    const newKey = await keyPair("new");
    let keys: object[] = [oldKey.jwk];
    const calls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response(JSON.stringify({ keys })); }) as typeof fetch;
    const opts = { team: TEAM, aud: AUD, fetchFn: fn, now };
    expect(await verifyAccessJwt(await sign(oldKey.pair.privateKey, "old", claims()), opts)).not.toBeNull();
    keys = [newKey.jwk];
    expect(await verifyAccessJwt(await sign(newKey.pair.privateKey, "new", claims()), opts)).not.toBeNull();
    expect(calls).toHaveLength(2);
    // Неизвестный ключ не заставляет ходить за ключами на каждом запросе.
    expect(await verifyAccessJwt(await sign(oldKey.pair.privateKey, "ghost", claims()), opts)).toBeNull();
    expect(await verifyAccessJwt(await sign(oldKey.pair.privateKey, "ghost", claims()), opts)).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe("роли пульта: выдача страниц", () => {
  // Статика как в Pages: index.html отдаётся по папке, reg.html — без расширения.
  function assets(files: Record<string, string>) {
    const asked: string[] = [];
    return {
      asked,
      fetch: async (input: Request | string | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        asked.push(url.pathname);
        if (url.pathname.endsWith(".html")) {
          const pretty = url.pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
          return new Response(null, { status: 308, headers: { location: pretty } });
        }
        const file = url.pathname.endsWith("/") ? `${url.pathname}index.html` : `${url.pathname}.html`;
        return file in files
          ? new Response(files[file], { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0" } })
          : new Response("not found", { status: 404 });
      }
    };
  }
  const site = {
    "/_r/all/index.html": "ПОЛНЫЙ ПУЛЬТ",
    "/_r/all/reg.html": "ПОЛНАЯ ВЫРУЧКА",
    "/_r/tv/index.html": "ПУЛЬТ ДЛЯ ТЕЛЕВИЗОРА"
  };
  const config = parseGateConfig(JSON.stringify({
    team: TEAM, aud: AUD,
    users: { "boss@example.test": "all", "seller@example.test": "manager:2381", "tv@example.test": "tv" }
  }));
  const req = (pathname: string, headers: Record<string, string> = {}) =>
    new Request(`https://pult.example.test${pathname}`, { headers });

  it("без секрета все, кого пустил Access, видят полный пульт, как раньше", async () => {
    const a = assets(site);
    for (const [p, text] of [["/", "ПОЛНЫЙ ПУЛЬТ"], ["/index.html", "ПОЛНЫЙ ПУЛЬТ"], ["/reg", "ПОЛНАЯ ВЫРУЧКА"], ["/reg.html", "ПОЛНАЯ ВЫРУЧКА"]]) {
      const res = await handleGateRequest(req(p), { config: null, assets: a });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(text);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("закрывает прямые адреса вариантов и всё лишнее", async () => {
    const a = assets(site);
    for (const p of ["/_r/all/", "/_r/all/index.html", "/_r/all/reg", "/_r/tv/", "/payload.json", "/favicon.ico", "/reg/../_r/all/"]) {
      const res = await handleGateRequest(req(p), { config, assets: a });
      expect(res.status, p).toBe(404);
      expect(await res.text()).not.toContain("ПОЛН");
    }
    expect((await handleGateRequest(new Request("https://pult.example.test/", { method: "POST" }), { config, assets: a })).status).toBe(405);
  });

  async function asUser(email: string, pathname: string, files = site) {
    clearJwksCache();
    const { pair, jwk } = await keyPair("k1");
    const { fn } = jwksFetch([jwk]);
    const token = await sign(pair.privateKey, "k1", claims({ email }));
    return handleGateRequest(req(pathname, { "Cf-Access-Jwt-Assertion": token }), { config, assets: assets(files), fetchFn: fn, now: () => now });
  }

  it("пускает по роли из секрета", async () => {
    const boss = await asUser("BOSS@example.test", "/reg");
    expect(boss.status).toBe(200);
    expect(await boss.text()).toBe("ПОЛНАЯ ВЫРУЧКА");
    const tv = await asUser("tv@example.test", "/");
    expect(await tv.text()).toBe("ПУЛЬТ ДЛЯ ТЕЛЕВИЗОРА");
  });

  it("берёт токен и из куки CF_Authorization", async () => {
    clearJwksCache();
    const { pair, jwk } = await keyPair("k1");
    const { fn } = jwksFetch([jwk]);
    const token = await sign(pair.privateKey, "k1", claims());
    const res = await handleGateRequest(req("/", { cookie: `other=1; CF_Authorization=${token}` }), { config, assets: assets(site), fetchFn: fn, now: () => now });
    expect(await res.text()).toBe("ПОЛНЫЙ ПУЛЬТ");
  });

  it("без токена или с плохим токеном — нет доступа", async () => {
    const a = assets(site);
    const none = await handleGateRequest(req("/"), { config, assets: a });
    expect(none.status).toBe(403);
    expect(await none.text()).not.toContain("ПОЛН");
    const bad = await handleGateRequest(req("/", { "Cf-Access-Jwt-Assertion": "x.y.z" }), { config, assets: a, fetchFn: jwksFetch([]).fn });
    expect(bad.status).toBe(403);
    expect(a.asked).toEqual([]);
  });

  it("почты нет в списке — страница «нет доступа» с этой почтой и выходом", async () => {
    const res = await asUser("stranger<b>@example.test", "/");
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Нет доступа");
    expect(html).toContain("stranger&lt;b&gt;@example.test");
    expect(html).toContain("/cdn-cgi/access/logout");
    expect(html).not.toContain("ПОЛН");
  });

  it("вид роли ещё не собран — не отдаёт полный пульт вместо него", async () => {
    const res = await asUser("seller@example.test", "/");
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("ещё не готов");
    expect(html).not.toContain("ПОЛН");
  });

  it("страницы нет в виде роли — «эта страница вам недоступна» со ссылкой на пульт", async () => {
    const res = await asUser("tv@example.test", "/reg");
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("недоступна");
    expect(html).toContain('href="./"');
    expect(html).not.toContain("ПОЛН");
  });
});

describe("роли пульта: конфиг для выкладки", () => {
  const run = (env: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-gate-"));
    const out = path.join(dir, "config.json");
    const res = spawnSync("npx", ["tsx", "scripts/pult-gate-config.mts", out], { encoding: "utf8", env: { ...process.env, PULT_ROLES: "", ...env } });
    return { res, out };
  };

  it("без секрета пишет null и говорит, что роли выключены", () => {
    const { res, out } = run({});
    expect(res.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toBeNull();
    expect(res.stdout).toContain("выключены");
  }, 30000);

  it("с секретом пишет разобранный конфиг и не печатает почты", () => {
    const secret = JSON.stringify({ team: TEAM, aud: AUD, users: { "Boss@Example.test": "all", "seller@example.test": "manager:2381" } });
    const { res, out } = run({ PULT_ROLES: secret });
    expect(res.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).users["boss@example.test"]).toEqual({ kind: "all" });
    expect(res.stdout + res.stderr).not.toMatch(/example\.test/i);
    expect(res.stdout).toMatch(/включены.*2/);
  }, 30000);

  it("с ошибкой в секрете падает", () => {
    const { res } = run({ PULT_ROLES: "{" });
    expect(res.status).not.toBe(0);
  }, 30000);
});

describe("роли пульта: выкладка", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/sales-pult.yml"), "utf8");
  const deploy = workflow.slice(workflow.indexOf("- name: Deploy to Cloudflare Pages"));

  it("собирает конфиг ролей из секрета и кладёт полный пульт в вариант all", () => {
    expect(deploy).toContain("PULT_ROLES: ${{ secrets.PULT_ROLES }}");
    expect(deploy).toContain("npx tsx scripts/pult-gate-config.mts exports/pult-gate/config.json");
    expect(deploy).toContain("exports/sales-pult-deploy/_r/all/index.html");
    expect(deploy).toContain("exports/sales-pult-deploy/_r/all/reg.html");
    // Корневых index.html и reg.html больше нет: всё отдаёт проверка входа.
    expect(deploy).not.toMatch(/cp [^\n]*exports\/sales-pult-deploy\/index\.html/);
    // Выкладка идёт из корня репозитория, иначе wrangler не найдёт папку functions.
    expect(deploy).toContain("npx wrangler pages deploy exports/sales-pult-deploy --project-name f3-pult");
    expect(deploy.indexOf("pult-gate-config")).toBeLessThan(deploy.indexOf("wrangler pages deploy"));
  });

  it("промежуточный код берёт конфиг, собранный при выкладке", () => {
    const middleware = fs.readFileSync(path.resolve("functions/_middleware.ts"), "utf8");
    expect(middleware).toContain("../exports/pult-gate/config.json");
    expect(middleware).toContain("handleGateRequest");
    expect(middleware).toContain("env.ASSETS");
  });
});
