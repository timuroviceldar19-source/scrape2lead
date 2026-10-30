import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptPayload,
  decryptPayload,
  saveEncryptedRegisterHistory,
  loadEncryptedRegisterHistory,
  shouldRefreshRegisterHistory,
  DEFAULT_REGISTER_CACHE_DIR,
  DEFAULT_REGISTER_HISTORY_PATH
} from "../../src/bitrix/salesPult/register/crypto.js";
import type { RegisterHistoryPayload } from "../../src/bitrix/salesPult/register/types.js";

describe("Register History AES-256-GCM Encryption (crypto.ts)", () => {
  const testKey = "test-secret-key-1234567890-abcdef";
  const samplePayload: RegisterHistoryPayload = {
    asOf: "2026-10-30",
    months: [
      {
        month: "2026-08",
        label: "Август 2026",
        fileName: "ОП 31.08.26.xlsx",
        sale: 50000000,
        val: 15000000,
        margin: 0.3,
        contracts: 10,
        plan: 60000000,
        planPct: 83.3,
        hasVal: true,
        byManager: [
          {
            name: "Секретный Менеджер",
            sale: 50000000,
            val: 15000000,
            margin: 0.3,
            contracts: 10,
            plan: 60000000,
            planPct: 83.3
          }
        ]
      }
    ]
  };

  it("encrypts and decrypts payload round-trip", () => {
    const json = JSON.stringify(samplePayload);
    const encrypted = encryptPayload(json, testKey);

    expect(typeof encrypted).toBe("string");
    const envelope = JSON.parse(encrypted);
    expect(envelope.alg).toBe("aes-256-gcm");
    expect(envelope.iv).toBeDefined();
    expect(envelope.tag).toBeDefined();
    expect(envelope.data).toBeDefined();

    // Verify ciphertext does not leak plaintext strings
    expect(encrypted).not.toContain("Секретный Менеджер");
    expect(encrypted).not.toContain("50000000");
    expect(encrypted).not.toContain("Август 2026");

    const decrypted = decryptPayload(encrypted, testKey);
    const restored = JSON.parse(decrypted);
    expect(restored).toEqual(samplePayload);
  });

  it("fails to decrypt with wrong key and throws or returns clear error", () => {
    const json = JSON.stringify(samplePayload);
    const encrypted = encryptPayload(json, testKey);

    expect(() => {
      decryptPayload(encrypted, "wrong-key-xyz");
    }).toThrow();
  });

  describe("saveEncryptedRegisterHistory and loadEncryptedRegisterHistory", () => {
    let tmpDir: string;
    let cachePath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-crypto-test-"));
      cachePath = path.join(tmpDir, "history.enc.json");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("saves encrypted file and loads successfully with valid key", () => {
      const ok = saveEncryptedRegisterHistory(cachePath, samplePayload, testKey);
      expect(ok).toBe(true);
      expect(fs.existsSync(cachePath)).toBe(true);

      const rawOnDisk = fs.readFileSync(cachePath, "utf8");
      expect(rawOnDisk).not.toContain("Секретный Менеджер");
      expect(rawOnDisk).not.toContain("50000000");

      const res = loadEncryptedRegisterHistory(cachePath, testKey);
      expect(res.source).toBe("cache");
      expect(res.error).toBeUndefined();
      expect(res.payload?.months[0].month).toBe("2026-08");
    });

    it("returns error without throwing when key is missing (REGISTER_HISTORY_KEY not set)", () => {
      const ok = saveEncryptedRegisterHistory(cachePath, samplePayload, "");
      expect(ok).toBe(false);
      expect(fs.existsSync(cachePath)).toBe(false);

      const res = loadEncryptedRegisterHistory(cachePath, "");
      expect(res.source).toBe("none");
      expect(res.payload).toBeUndefined();
      expect(res.error).toContain("не задан ключ кэша");
    });

    it("returns error without crashing when wrong key is passed to loadEncryptedRegisterHistory", () => {
      saveEncryptedRegisterHistory(cachePath, samplePayload, testKey);

      const res = loadEncryptedRegisterHistory(cachePath, "invalid-key-abc");
      expect(res.source).toBe("none");
      expect(res.payload).toBeUndefined();
      expect(res.error).toContain("ошибка расшифровки кэша");
    });
  });

  describe("shouldRefreshRegisterHistory", () => {
    it("returns true when forceRefresh is true", () => {
      const refresh = shouldRefreshRegisterHistory({
        cacheFilePath: "non-existent-path.json",
        forceRefresh: true
      });
      expect(refresh).toBe(true);
    });

    it("returns true when cache file does not exist", () => {
      const refresh = shouldRefreshRegisterHistory({
        cacheFilePath: "non-existent-path.json",
        forceRefresh: false
      });
      expect(refresh).toBe(true);
    });

    it("returns true when cache is older than 20 hours", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-test-"));
      const cachePath = path.join(tmpDir, "hist.json");
      fs.writeFileSync(cachePath, "{}");

      // 21 hours ago
      const now = new Date("2026-10-30T10:00:00+05:00");
      const mtime = new Date(now.getTime() - 21 * 3600 * 1000);
      fs.utimesSync(cachePath, mtime, mtime);

      const refresh = shouldRefreshRegisterHistory({
        cacheFilePath: cachePath,
        nowIso: now.toISOString()
      });
      expect(refresh).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns true on first run after 08:00 Almaty if cache was created before 08:00 today", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-test-"));
      const cachePath = path.join(tmpDir, "hist.json");
      fs.writeFileSync(cachePath, "{}");

      // Cache created today at 07:30 Almaty (02:30 UTC), now is 08:15 Almaty (03:15 UTC)
      const now = new Date("2026-10-30T08:15:00+05:00");
      const mtime = new Date("2026-10-30T07:30:00+05:00");
      fs.utimesSync(cachePath, mtime, mtime);

      const refresh = shouldRefreshRegisterHistory({
        cacheFilePath: cachePath,
        nowIso: now.toISOString()
      });
      expect(refresh).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns false during daytime 15-minute runs if cache was already created after 08:00 today", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-test-"));
      const cachePath = path.join(tmpDir, "hist.json");
      fs.writeFileSync(cachePath, "{}");

      // Cache created today at 08:05 Almaty, now is 09:30 Almaty
      const now = new Date("2026-10-30T09:30:00+05:00");
      const mtime = new Date("2026-10-30T08:05:00+05:00");
      fs.utimesSync(cachePath, mtime, mtime);

      const refresh = shouldRefreshRegisterHistory({
        cacheFilePath: cachePath,
        nowIso: now.toISOString()
      });
      expect(refresh).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns false when last attempt failed < 1 hour ago unless forceRefresh is true", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-attempt-test-"));
      const cachePath = path.join(tmpDir, "hist.json");
      const attemptPath = path.join(tmpDir, "last_attempt.json");
      fs.writeFileSync(cachePath, "{}");

      // Cache is old (21 hours old), but failed attempt was 15 minutes ago
      const now = new Date("2026-10-30T10:00:00+05:00");
      const mtime = new Date(now.getTime() - 21 * 3600 * 1000);
      fs.utimesSync(cachePath, mtime, mtime);

      fs.writeFileSync(
        attemptPath,
        JSON.stringify({
          success: false,
          error: "Connection timeout to disk",
          timestamp: new Date(now.getTime() - 15 * 60 * 1000).toISOString()
        })
      );

      const refresh = shouldRefreshRegisterHistory({
        cacheFilePath: cachePath,
        attemptFilePath: attemptPath,
        nowIso: now.toISOString(),
        forceRefresh: false
      });
      expect(refresh).toBe(false);

      // With forceRefresh: true, it should still refresh
      const forced = shouldRefreshRegisterHistory({
        cacheFilePath: cachePath,
        attemptFilePath: attemptPath,
        nowIso: now.toISOString(),
        forceRefresh: true
      });
      expect(forced).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
