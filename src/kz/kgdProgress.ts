import fs from "node:fs";
import path from "node:path";

type Stage = "counterparty" | "liquidation" | "bulk";
type State = { version: 1; records: Record<string, Partial<Record<Stage, unknown>>> };

export class KgdProgressStore {
  private state: State;
  constructor(private readonly filePath: string) { this.state = this.read(); }
  getStage<T>(bin: string, stage: Stage): T | undefined { return this.state.records[bin]?.[stage] as T | undefined; }
  saveStage(bin: string, stage: Stage, value: unknown): void {
    this.state.records[bin] ??= {}; this.state.records[bin][stage] = stripSecrets(value); this.writeAtomic();
  }
  private read(): State { if (!fs.existsSync(this.filePath)) return { version: 1, records: {} }; const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as State; return parsed.version === 1 && parsed.records ? parsed : { version: 1, records: {} }; }
  private writeAtomic(): void { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); fs.renameSync(temp, this.filePath); }
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/(captcha|cookie|token|authorization|password)/i.test(key)).map(([key, val]) => [key, stripSecrets(val)]));
  return value;
}
