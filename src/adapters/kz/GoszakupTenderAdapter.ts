import { fetchGoszakupTenders, isGoszakupAvailable } from "../../kz/goszakupCollector.js";
import type { TenderRecord } from "../../kz/tenderTypes.js";
import type { ITenderSourceAdapter } from "./types.js";

export class GoszakupTenderAdapter implements ITenderSourceAdapter {
  readonly source = "goszakup.gov.kz" as const;
  readonly requiresAuth = true;

  isAvailable(): boolean {
    return isGoszakupAvailable();
  }

  async fetchTendersByBin(bin: string): Promise<TenderRecord[]> {
    return fetchGoszakupTenders(bin);
  }
}
