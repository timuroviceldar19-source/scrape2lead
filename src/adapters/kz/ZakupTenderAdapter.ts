import { collectZakupTendersForBatch } from "../../kz/zakupCollector.js";
import type { TenderRecord } from "../../kz/tenderTypes.js";
import type { ITenderSourceAdapter } from "./types.js";

export class ZakupTenderAdapter implements ITenderSourceAdapter {
  readonly source = "zakup.sk.kz" as const;
  readonly requiresAuth = false;

  isAvailable(): boolean {
    return true;
  }

  async fetchTendersByBin(bin: string, companyName?: string): Promise<TenderRecord[]> {
    const result = await collectZakupTendersForBatch([{ bin, companyName: companyName ?? null }]);
    return result.tenders;
  }
}
