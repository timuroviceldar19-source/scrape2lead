import { logger } from "../logger.js";
import type { BrowserSessionManager } from "../browser/browserSessionManager.js";
import type { RuntimeConfig } from "../types.js";
import type { IStorage } from "../storage/interface.js";

interface ProxyCredentials {
  server: string;
  username?: string;
  password?: string;
  channel: string | null;
  ip: string | null;
}

export interface ProxyRuntimeState {
  proxy: string | null;
  proxyChannel: string | null;
  ip: string | null;
  cardsOnIp: number;
}

export class ProxyRotator {
  private cardCount = 0;
  private cardsOnIp = 0;
  private currentProxy: string | null = null;
  private currentChannel: string | null = null;
  private currentIp: string | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly storage: IStorage,
    private readonly browserSession: BrowserSessionManager
  ) {}

  async tick(): Promise<void> {
    this.cardsOnIp += 1;
    this.cardCount += 1;
    if (this.shouldRotate()) {
      await this.rotate("scheduled");
    }
  }

  getCurrentState(): ProxyRuntimeState {
    return {
      proxy: this.currentProxy,
      proxyChannel: this.currentChannel,
      ip: this.currentIp,
      cardsOnIp: this.cardsOnIp
    };
  }

  shouldRotate(): boolean {
    return (
      this.config.proxyApiUrl !== undefined &&
      this.cardCount > 0 &&
      this.cardCount % this.config.rotateEveryN === 0
    );
  }

  async rotate(reason: string): Promise<void> {
    if (!this.config.proxyApiUrl) return;

    let newProxy: ProxyCredentials | undefined;
    try {
      const response = await fetch(this.config.proxyApiUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") ?? "";
      const raw: unknown = contentType.includes("application/json")
        ? await response.json()
        : (await response.text()).trim();
      newProxy = parseProxyData(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("proxy rotation API failed", { message });
      await this.storage.saveProxyRotation({
        proxy: this.currentProxy,
        proxyChannel: this.currentChannel,
        ip: this.currentIp,
        reason,
        cardsOnIp: this.cardsOnIp
      });
      return;
    }

    const cardsOnIp = this.cardsOnIp;
    this.cardsOnIp = 0;
    this.currentProxy = newProxy.server;
    this.currentChannel = newProxy.channel;
    this.currentIp = newProxy.ip;

    await this.storage.saveProxyRotation({
      proxy: newProxy.server,
      proxyChannel: newProxy.channel,
      ip: newProxy.ip,
      reason,
      cardsOnIp,
      rotatedAt: new Date().toISOString()
    });

    // Pass only the browser-relevant credential subset to the session manager.
    await this.browserSession.restartWithProxy({
      server: newProxy.server,
      username: newProxy.username,
      password: newProxy.password
    });
    logger.info("proxy rotated", { reason, hasCredentials: Boolean(newProxy.username || newProxy.password) });
  }
}

function extractIp(server: string): string | null {
  try {
    return new URL(server).hostname || null;
  } catch {
    return null;
  }
}

function parseProxyData(raw: unknown): ProxyCredentials {
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const channel =
      typeof obj["proxy_channel"] === "string" ? obj["proxy_channel"] :
      typeof obj["channel"] === "string" ? obj["channel"] : null;
    if (typeof obj["server"] === "string") {
      const server = obj["server"];
      const ip = typeof obj["ip"] === "string" ? obj["ip"] : extractIp(server);
      return {
        server,
        username: typeof obj["username"] === "string" ? obj["username"] : undefined,
        password: typeof obj["password"] === "string" ? obj["password"] : undefined,
        channel,
        ip
      };
    }
    if (typeof obj["proxy"] === "string") {
      const parsed = parseProxyString(obj["proxy"]);
      return { ...parsed, channel };
    }
  }
  if (typeof raw === "string") {
    return parseProxyString(raw);
  }
  throw new Error("unexpected proxy API response format");
}

function parseProxyString(raw: string): ProxyCredentials {
  try {
    const url = new URL(raw);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
      channel: null,
      ip: url.hostname || null
    };
  } catch {
    return { server: raw, channel: null, ip: null };
  }
}
