import type { StatGovRecord, TenderRecord, TenderSource } from "../../kz/tenderTypes.js";

export interface IStatGovAdapter {
  ensureSession(): Promise<void>;
  fetchByBin(bin: string): Promise<StatGovRecord | null>;
}

export interface ITenderSourceAdapter {
  readonly source: TenderSource;
  readonly requiresAuth: boolean;
  isAvailable(): boolean;
  fetchTendersByBin(bin: string, companyName?: string): Promise<TenderRecord[]>;
}
