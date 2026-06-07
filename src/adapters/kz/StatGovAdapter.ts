import fs from "node:fs";
import { collectStatGovForBins } from "../../kz/statGovCollector.js";
import { KzStorage } from "../../kz/kzStorage.js";
import type { StatGovRecord } from "../../kz/tenderTypes.js";
import type { IStatGovAdapter } from "./types.js";

export interface StatGovAdapterOptions {
  databasePath?: string;
  sessionPath?: string;
  delayMs?: number;
  forceRefresh?: boolean;
}

export class StatGovAdapter implements IStatGovAdapter {
  constructor(private readonly options: StatGovAdapterOptions = {}) {}

  async ensureSession(): Promise<void> {
    const sessionPath = this.options.sessionPath ?? process.env.STAT_GOV_SESSION_PATH ?? "data/stat-gov-session.json";
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`stat.gov session not found at ${sessionPath}`);
    }
  }

  async fetchByBin(bin: string): Promise<StatGovRecord | null> {
    await collectStatGovForBins([bin], this.options);
    const storage = new KzStorage({ databasePath: this.options.databasePath });
    try {
      return storage.getStatGovByBin(bin);
    } finally {
      storage.close();
    }
  }
}
