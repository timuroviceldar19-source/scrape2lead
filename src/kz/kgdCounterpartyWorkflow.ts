import type { BulkCheck, CounterpartyCheck, CounterpartyPayloadResult } from "./kgdCounterpartyTypes.js";
import { KgdProgressStore } from "./kgdProgress.js";
import { evaluateCounterpartyRisk } from "./kgdTrafficLight.js";

export interface CounterpartyWorkflowDependencies {
  progressPath: string;
  checkCounterparty(bin: string): Promise<CounterpartyPayloadResult>;
  checkLiquidation(bin: string): Promise<{ active: boolean; startDate?: string }>;
  checkBulk(bin: string): Promise<BulkCheck[]>;
  onProgress?: (message: string) => void;
}

export async function runCounterpartyChecks(bins: string[], deps: CounterpartyWorkflowDependencies): Promise<CounterpartyCheck[]> {
  const store = new KgdProgressStore(deps.progressPath); const results: CounterpartyCheck[] = [];
  for (const [index, bin] of bins.entries()) {
    deps.onProgress?.(`[${index + 1}/${bins.length}] БИН ${bin}`);
    let counterparty = store.getStage<CounterpartyPayloadResult>(bin, "counterparty"); let liquidation = store.getStage<{ active: boolean; startDate?: string }>(bin, "liquidation"); let bulkChecks = store.getStage<BulkCheck[]>(bin, "bulk");
    let counterpartyError: unknown, liquidationError: unknown, bulkError: unknown;
    if (!counterparty) try { counterparty = await deps.checkCounterparty(bin); store.saveStage(bin, "counterparty", counterparty); } catch (error) { counterpartyError = error; }
    if (!liquidation) try { liquidation = await deps.checkLiquidation(bin); store.saveStage(bin, "liquidation", liquidation); } catch (error) { liquidationError = error; }
    if (!bulkChecks) try { bulkChecks = await deps.checkBulk(bin); store.saveStage(bin, "bulk", bulkChecks); } catch (error) { bulkError = error; }
    const check: CounterpartyCheck = { bin, name: counterparty?.name ?? "", validBin: /^\d{12}$/.test(bin), vat: counterparty?.vat ?? { status: "unknown" }, bankruptcy: counterparty?.bankruptcy ?? false, liquidation: liquidation ?? { active: false }, esfRestricted: counterparty?.esfRestricted ?? false, unreliable: counterparty?.unreliable ?? false, unreliableReasons: counterparty?.unreliableReasons ?? [], bulkChecks: bulkChecks ?? unavailableBulkChecks(), stages: { counterparty: stage(counterparty, counterpartyError), liquidation: stage(liquidation, liquidationError), bulk: stage(bulkChecks, bulkError) }, checkedAt: new Date().toISOString(), links: ["https://portal.kgd.gov.kz/pages/info-services/find-information-for-ip-ul", "https://portal.kgd.gov.kz/pages/info-services/find-liquidated-taxpayer"] };
    const risk = evaluateCounterpartyRisk(check); results.push({ ...check, ...risk });
  }
  return results;
}

function stage(value: unknown, error: unknown): "complete" | "captcha_required" | "unavailable" { if (value !== undefined) return "complete"; return /captcha/i.test(String(error)) ? "captcha_required" : "unavailable"; }
function unavailableBulkChecks(): BulkCheck[] { return [{ source: "insolvent", status: "unavailable", matched: false, sourceUrl: "https://kgd.gov.kz/ru/section/spiski-nesostoyatelnyh-dolzhnikov" }, { source: "forced_liquidation", status: "unavailable", matched: false, sourceUrl: "https://www.kgd.gov.kz/ru/content/spisok-lic-likvidirovannyh-po-prinuditelnoy-likvidacii-1" }]; }
