import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyRotator } from "../src/proxy/proxyRotator.js";
import { logger } from "../src/logger.js";
import type { BrowserSessionManager } from "../src/browser/browserSessionManager.js";
import type { Storage } from "../src/storage/storage.js";
import type { RuntimeConfig } from "../src/types.js";

const baseConfig: RuntimeConfig = {
  source: "2gis",
  geo: "moscow",
  category: "cafe",
  limit: 10,
  databasePath: ":memory:",
  exportDir: "exports",
  delayRangeMs: [0, 1],
  rotateEveryN: 3,
  maxRetries: 0,
  concurrency: 1,
  headless: true,
  rawSnapshotDir: "raw_snapshots",
  proxyApiUrl: "http://proxy-api.example.com/rotate",
  proxy: { server: "http://gw.dataimpulse.com:823", username: "u", password: "p" }
};

const noApiCfg: RuntimeConfig = { ...baseConfig, proxyApiUrl: undefined };

function makeStorage() {
  return { saveProxyRotation: vi.fn() } as unknown as Storage;
}

function makeSession() {
  return { restartWithProxy: vi.fn().mockResolvedValue(undefined) } as unknown as BrowserSessionManager;
}

function jsonFetch(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => data
  });
}

describe("ProxyRotator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("shouldRotate()", () => {
    it("returns false when count has not yet reached rotateEveryN", async () => {
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.tick();
      await rotator.tick();
      expect(rotator.shouldRotate()).toBe(false);
    });

    it("returns true when count is a multiple of rotateEveryN", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.tick();
      await rotator.tick();
      await rotator.tick(); // count = 3, rotate fires, then count % 3 still 0
      expect(rotator.shouldRotate()).toBe(true);
    });

    it("returns true in no-api mode when rotateEveryN threshold is reached", async () => {
      // No proxyApiUrl but a static `proxy` is configured. shouldRotate()
      // should still fire so the rotator can restart the browser and pick
      // up a fresh IP from a backconnect rotating gateway (dataimpulse).
      const rotator = new ProxyRotator(noApiCfg, makeStorage(), makeSession());
      await rotator.tick();
      await rotator.tick();
      await rotator.tick();
      expect(rotator.shouldRotate()).toBe(true);
    });

    it("returns true at the threshold regardless of proxyApiUrl — shouldRotate is a timing predicate, rotate() decides if it can act", async () => {
      const cfg: RuntimeConfig = { ...baseConfig, proxyApiUrl: undefined, proxy: undefined };
      const rotator = new ProxyRotator(cfg, makeStorage(), makeSession());
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(rotator.shouldRotate()).toBe(true);
    });
  });

  describe("tick() — rotation trigger", () => {
    it("does not call fetch before rotateEveryN cards", async () => {
      const fetchMock = jsonFetch({ server: "http://1.2.3.4:8080" });
      vi.stubGlobal("fetch", fetchMock);
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.tick();
      await rotator.tick();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("calls fetch exactly once after rotateEveryN ticks", async () => {
      const fetchMock = jsonFetch({ server: "http://1.2.3.4:8080" });
      vi.stubGlobal("fetch", fetchMock);
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(baseConfig.proxyApiUrl);
    });

    it("calls fetch again after 2×rotateEveryN ticks", async () => {
      const fetchMock = jsonFetch({ server: "http://1.2.3.4:8080" });
      vi.stubGlobal("fetch", fetchMock);
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      for (let i = 0; i < 6; i++) await rotator.tick();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not call fetch when proxyApiUrl is absent", async () => {
      const fetchMock = jsonFetch({ server: "http://1.2.3.4:8080" });
      vi.stubGlobal("fetch", fetchMock);
      const cfg = { ...baseConfig, proxyApiUrl: undefined };
      const rotator = new ProxyRotator(cfg, makeStorage(), makeSession());
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("rotate() — proxy_history writes", () => {
    it("saves proxy server, ip, and cardsOnIp to history on success", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: "http://1.2.3.4:8080",
          ip: "1.2.3.4",
          reason: "scheduled",
          cardsOnIp: 3
        })
      );
    });

    it("saves null proxy to history on API failure with cardsOnIp count", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ proxy: null, reason: "scheduled", cardsOnIp: 3 })
      );
    });

    it("saves null proxy to history on non-ok HTTP response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: () => null }
      }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ proxy: null, reason: "scheduled" })
      );
    });

    it("passes reason to history when rotate() called directly", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://5.6.7.8:3128" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      await rotator.rotate("captcha");
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ proxy: "http://5.6.7.8:3128", reason: "captcha" })
      );
    });
  });

  describe("rotate() — browser session restart", () => {
    it("restarts session with parsed proxy on success", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080", username: "u", password: "p" }));
      const session = makeSession();
      const rotator = new ProxyRotator(baseConfig, makeStorage(), session);
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(session.restartWithProxy).toHaveBeenCalledWith({
        server: "http://1.2.3.4:8080",
        username: "u",
        password: "p"
      });
    });

    it("does not restart session on API failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
      const session = makeSession();
      const rotator = new ProxyRotator(baseConfig, makeStorage(), session);
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(session.restartWithProxy).not.toHaveBeenCalled();
    });

    it("parses proxy URL string from plain-text response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "text/plain" },
        text: async () => "http://user:secret@9.9.9.9:8888"
      }));
      const session = makeSession();
      const rotator = new ProxyRotator(baseConfig, makeStorage(), session);
      await rotator.rotate("manual");
      expect(session.restartWithProxy).toHaveBeenCalledWith({
        server: "http://9.9.9.9:8888",
        username: "user",
        password: "secret"
      });
    });

    it("parses proxy from JSON {proxy: url} shape", async () => {
      vi.stubGlobal("fetch", jsonFetch({ proxy: "http://10.0.0.1:3128" }));
      const session = makeSession();
      const rotator = new ProxyRotator(baseConfig, makeStorage(), session);
      await rotator.rotate("manual");
      expect(session.restartWithProxy).toHaveBeenCalledWith(
        expect.objectContaining({ server: "http://10.0.0.1:3128" })
      );
    });
  });

  describe("rotate() — no-api mode (backconnect rotating gateway)", () => {
    // dataimpulse-style setup: no proxyApiUrl, only a static `proxy` pointing
    // at a rotating port (e.g. gw.dataimpulse.com:823). A fresh IP is handed
    // out per TCP connection, so a browser restart is enough to rotate.

    it("restarts the browser with the existing proxy when threshold is reached", async () => {
      const session = makeSession();
      const storage = makeStorage();
      const rotator = new ProxyRotator(noApiCfg, storage, session);
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(session.restartWithProxy).toHaveBeenCalledWith(baseConfig.proxy);
    });

    it("does not call fetch in no-api mode", async () => {
      const fetchMock = jsonFetch({ server: "http://1.2.3.4:8080" });
      vi.stubGlobal("fetch", fetchMock);
      const session = makeSession();
      const rotator = new ProxyRotator(noApiCfg, makeStorage(), session);
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("writes a proxy_history row with the existing server and reset cardsOnIp", async () => {
      const session = makeSession();
      const storage = makeStorage();
      const rotator = new ProxyRotator(noApiCfg, storage, session);
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: baseConfig.proxy!.server,
          reason: "scheduled",
          cardsOnIp: 3
        })
      );
    });

    it("is a no-op when neither proxyApiUrl nor proxy is configured", async () => {
      const cfg: RuntimeConfig = { ...baseConfig, proxyApiUrl: undefined, proxy: undefined };
      const session = makeSession();
      const storage = makeStorage();
      const rotator = new ProxyRotator(cfg, storage, session);
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(session.restartWithProxy).not.toHaveBeenCalled();
      expect(storage.saveProxyRotation).not.toHaveBeenCalled();
    });
  });

  describe("rotate() — safe logging", () => {
    it("does not log server, IP, URL, username, or password in proxy rotated event", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080", username: "u", password: "p" }));
      const infoSpy = vi.spyOn(logger, "info");

      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.rotate("scheduled");

      const call = infoSpy.mock.calls.find(([msg]) => msg === "proxy rotated");
      expect(call, "logger.info('proxy rotated') was not called").toBeDefined();

      const meta = call![1] as Record<string, unknown>;
      expect(meta).not.toHaveProperty("server");
      expect(meta).not.toHaveProperty("proxy");
      expect(meta).not.toHaveProperty("username");
      expect(meta).not.toHaveProperty("password");

      const serialized = JSON.stringify(call);
      expect(serialized).not.toMatch(/\d+\.\d+\.\d+\.\d+/);   // no IP address
      expect(serialized).not.toMatch(/https?:\/\//);            // no URL scheme

      expect(meta["reason"]).toBe("scheduled");
      expect(meta["hasCredentials"]).toBe(true);

      infoSpy.mockRestore();
    });

    it("reports hasCredentials false when proxy has no auth", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const infoSpy = vi.spyOn(logger, "info");

      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.rotate("scheduled");

      const call = infoSpy.mock.calls.find(([msg]) => msg === "proxy rotated");
      expect((call![1] as Record<string, unknown>)["hasCredentials"]).toBe(false);

      infoSpy.mockRestore();
    });
  });

  describe("rotate() — proxy metadata enrichment", () => {
    it("JSON response with proxy_channel stores channel and extracted IP", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080", proxy_channel: "ch-us-1" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      await rotator.rotate("scheduled");
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: "http://1.2.3.4:8080",
          proxyChannel: "ch-us-1",
          ip: "1.2.3.4",
          reason: "scheduled"
        })
      );
    });

    it("JSON response with channel key (alternate spelling) is stored as proxyChannel", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://5.6.7.8:3128", channel: "ch-eu-2" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      await rotator.rotate("scheduled");
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ proxyChannel: "ch-eu-2", ip: "5.6.7.8" })
      );
    });

    it("plain URL string response extracts hostname as ip", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "text/plain" },
        text: async () => "http://9.9.9.9:8888"
      }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      await rotator.rotate("manual");
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ proxy: "http://9.9.9.9:8888", ip: "9.9.9.9", proxyChannel: null })
      );
    });

    it("cards_on_ip reflects the tick count since last successful rotation", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession()); // rotateEveryN=3
      for (let i = 0; i < 3; i++) await rotator.tick();
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ cardsOnIp: 3, reason: "scheduled" })
      );
    });

    it("cards_on_ip resets after successful rotation and re-accumulates", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession()); // rotateEveryN=3
      for (let i = 0; i < 6; i++) await rotator.tick(); // two rotations
      const calls = (storage.saveProxyRotation as ReturnType<typeof vi.fn>).mock.calls as Array<
        [Record<string, unknown>]
      >;
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toMatchObject({ cardsOnIp: 3 });
      expect(calls[1][0]).toMatchObject({ cardsOnIp: 3 }); // reset between rotations
    });

    it("failed rotation writes a history row with prior state and does not throw", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      await expect(rotator.rotate("blocked")).resolves.toBeUndefined();
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ proxy: null, proxyChannel: null, ip: null, reason: "blocked" })
      );
    });

    it("JSON response with explicit ip field uses it instead of parsing server hostname", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://proxy.example.com:8080", ip: "203.0.113.5" }));
      const storage = makeStorage();
      const rotator = new ProxyRotator(baseConfig, storage, makeSession());
      await rotator.rotate("manual");
      expect(storage.saveProxyRotation).toHaveBeenCalledWith(
        expect.objectContaining({ ip: "203.0.113.5" })
      );
    });
  });

  describe("getCurrentState()", () => {
    it("returns all-null proxy fields and cardsOnIp 0 before any rotation", () => {
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      expect(rotator.getCurrentState()).toEqual({
        proxy: null,
        proxyChannel: null,
        ip: null,
        cardsOnIp: 0
      });
    });

    it("returns current proxy/channel/IP and cardsOnIp 0 immediately after successful rotation", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080", proxy_channel: "ch-1" }));
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.rotate("manual");
      expect(rotator.getCurrentState()).toEqual({
        proxy: "http://1.2.3.4:8080",
        proxyChannel: "ch-1",
        ip: "1.2.3.4",
        cardsOnIp: 0
      });
    });

    it("cardsOnIp increments with ticks after a successful rotation", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.rotate("manual");
      await rotator.tick();
      await rotator.tick();
      expect(rotator.getCurrentState().cardsOnIp).toBe(2);
    });

    it("failed rotation does not change current state", async () => {
      // First, establish known state via a successful rotation.
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080", proxy_channel: "ch-1" }));
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.rotate("manual");

      // Now fail.
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
      await rotator.rotate("blocked");

      expect(rotator.getCurrentState()).toMatchObject({
        proxy: "http://1.2.3.4:8080",
        proxyChannel: "ch-1",
        ip: "1.2.3.4"
      });
    });

    it("returns a plain copy — mutating the result does not affect internal state", async () => {
      vi.stubGlobal("fetch", jsonFetch({ server: "http://1.2.3.4:8080" }));
      const rotator = new ProxyRotator(baseConfig, makeStorage(), makeSession());
      await rotator.rotate("manual");
      const state = rotator.getCurrentState();
      (state as unknown as Record<string, unknown>)["proxy"] = "tampered";
      expect(rotator.getCurrentState().proxy).toBe("http://1.2.3.4:8080");
    });
  });
});
