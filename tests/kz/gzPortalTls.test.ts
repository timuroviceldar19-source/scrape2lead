import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GZ_PORTAL_PINNED_SPKI, gzPortalChromiumArgs, gzPortalLaunchOptions } from "../../src/kz/gzPortalTls.js";

describe("GZ portal certificate pin", () => {
  it("passes the pinned key of procurement.gov.kz to Chromium", () => {
    expect(GZ_PORTAL_PINNED_SPKI).toEqual(["9RlsLxKR74pobuctfC2lt7f8FaL4ri1iZg4DflJ9mjI="]);
    expect(gzPortalChromiumArgs()).toEqual(["--ignore-certificate-errors-spki-list=9RlsLxKR74pobuctfC2lt7f8FaL4ri1iZg4DflJ9mjI="]);
  });
  it("keeps the caller's launch options and arguments", () => {
    expect(gzPortalLaunchOptions({ headless: false, slowMo: 50, args: ["--lang=ru-RU"] })).toEqual({
      headless: false, slowMo: 50, args: ["--lang=ru-RU", "--ignore-certificate-errors-spki-list=9RlsLxKR74pobuctfC2lt7f8FaL4ri1iZg4DflJ9mjI="]
    });
  });
  it("rejects a pin that is not a base64 SHA-256 hash", () => {
    expect(() => gzPortalChromiumArgs(["procurement.gov.kz"])).toThrow(/SHA-256/);
    expect(gzPortalChromiumArgs([])).toEqual([]);
  });
  it("routes every browser that opens the portal through the pin", () => {
    // Новый chromium.launch без ключа снова сломал бы сбор, пока сертификат портала просрочен.
    const files = ["src/kz/goszakupLotsNstruExporter.ts", "src/kz/goszakupRegistryCollector.ts", "src/kz/goszakupPlanCollector.ts",
      "src/kz/goszakupContractExporter.ts", "scripts/bitrix-push-gz-lots.mts", "scripts/bitrix-backfill-gz-plan-number.mts",
      "scripts/bitrix-correct-gz-plan-number.mts"];
    for (const file of files) {
      const launches = fs.readFileSync(file, "utf8").match(/chromium\.launch\([^\n]*/g) ?? [];
      expect(launches.length, file).toBeGreaterThan(0);
      for (const launch of launches) expect(launch, file).toContain("chromium.launch(gzPortalLaunchOptions(");
    }
  });
});

/**
 * Настоящий Chromium против локального HTTPS с самоподписанным сертификатом: для браузера это та же ошибка
 * сертификата, что и у просроченного сертификата портала. Закреплённый ключ пропускается, любой другой — нет.
 */
const openssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!openssl)("Chromium with the pinned key (local HTTPS)", () => {
  let dir = "";
  let server: https.Server;
  let url = "";
  let pin = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "s2l-pin-"));
    const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-days", "2"], { stdio: "ignore" });
    const der = new crypto.X509Certificate(fs.readFileSync(cert)).publicKey.export({ type: "spki", format: "der" });
    pin = crypto.createHash("sha256").update(der).digest("base64");
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>portal</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function open(pins: string[]): Promise<string> {
    const browser = await chromium.launch({ headless: true, args: gzPortalChromiumArgs(pins) });
    try {
      const page = await browser.newPage();
      const response = await page.goto(url, { timeout: 15_000 });
      return `HTTP ${response?.status()}`;
    } catch (error) {
      return String((error as Error).message).match(/net::ERR_[A-Z_]+/)?.[0] ?? String(error);
    } finally {
      await browser.close();
    }
  }

  it("opens the page whose certificate carries the pinned key", async () => {
    expect(await open([pin])).toBe("HTTP 200");
  }, 30_000);
  it("still rejects a certificate with any other key", async () => {
    expect(await open(GZ_PORTAL_PINNED_SPKI.slice())).toMatch(/^net::ERR_CERT_/);
    expect(await open([])).toMatch(/^net::ERR_CERT_/);
  }, 30_000);
});
