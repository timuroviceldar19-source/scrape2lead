import fs from "node:fs";
import path from "node:path";

export interface GzPublishedLedgerEntry {
  plan_point_id: string;
  previous_status: string | null;
  detected_status: string;
  detected_at: string;
  bitrix_lead_id: string | null;
  fingerprint: string;
}

export interface GzPublishedLedgerData {
  entries: Record<string, GzPublishedLedgerEntry>;
}

export class GzPublishedLedger {
  private data: GzPublishedLedgerData;

  constructor(private readonly filePath: string) {
    this.data = readLedger(filePath);
  }

  get(planPointId: string): GzPublishedLedgerEntry | null {
    return this.data.entries[planPointId] ?? null;
  }

  shouldUpdate(planPointId: string, fingerprint: string): boolean {
    const entry = this.get(planPointId);
    return !entry || entry.fingerprint !== fingerprint;
  }

  record(entry: GzPublishedLedgerEntry): void {
    this.data.entries[entry.plan_point_id] = entry;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}

export function buildGzPublishedFingerprint(input: {
  status: string;
  amount: string;
  planUrl: string;
  itemName: string;
  customerName: string;
}): string {
  return [
    input.status.trim(),
    input.amount.trim(),
    input.planUrl.trim(),
    input.itemName.trim(),
    input.customerName.trim()
  ].join("|");
}

function readLedger(filePath: string): GzPublishedLedgerData {
  if (!fs.existsSync(filePath)) {
    return { entries: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<GzPublishedLedgerData>;
  return {
    entries: parsed.entries ?? {}
  };
}
