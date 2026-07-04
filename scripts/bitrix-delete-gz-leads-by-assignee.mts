import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  type BitrixLeadCleanupCandidate,
  type BitrixUserSummary,
  buildGzLeadCleanupFilter,
  findExactUsersByName,
  formatBitrixUserName,
  isSafeGzLeadForAssignee
} from "../src/bitrix/gzLeadCleanup.js";

dotenv.config();

interface CliArgs {
  webhookUrl: string | null;
  assigneeName: string;
  assigneeId: string | null;
  execute: boolean;
  delayMs: number;
  reportPath: string;
}

interface CleanupReport {
  mode: "dry-run" | "execute";
  assignee: { id: string; name: string };
  filter: Record<string, string>;
  candidates: BitrixLeadCleanupCandidate[];
  deleted: Array<{ id: string; originId: string | null }>;
  failed: Array<{ id: string; originId: string | null; message: string }>;
  skippedUnsafe: BitrixLeadCleanupCandidate[];
  remainingAfterDelete: number | null;
  startedAt: string;
  finishedAt: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    webhookUrl: process.env.BITRIX24_WEBHOOK_URL?.trim() || null,
    assigneeName: "Эльдар Айткенов",
    assigneeId: null,
    execute: false,
    delayMs: 350,
    reportPath: path.join("logs", `bitrix-delete-gz-leads-${timestampForFile()}.json`)
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--webhook-url") args.webhookUrl = argv[++i]?.trim() || null;
    else if (arg === "--assignee-name") args.assigneeName = argv[++i]?.trim() || args.assigneeName;
    else if (arg === "--assignee-id") args.assigneeId = argv[++i]?.trim() || null;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i] ?? args.delayMs);
    else if (arg === "--report") args.reportPath = argv[++i] ?? args.reportPath;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.webhookUrl) throw new Error("BITRIX24_WEBHOOK_URL is required");

  const client = new BitrixClient(args.webhookUrl);
  const assignee = args.assigneeId
    ? { id: args.assigneeId, name: args.assigneeName }
    : await resolveUniqueUser(client, args.assigneeName);

  const filter = buildGzLeadCleanupFilter(assignee.id);
  const candidates = await client.listGzLeads(filter);
  const safeCandidates = candidates.filter((lead) => isSafeGzLeadForAssignee(lead, assignee.id));
  const skippedUnsafe = candidates.filter((lead) => !isSafeGzLeadForAssignee(lead, assignee.id));
  const report: CleanupReport = {
    mode: args.execute ? "execute" : "dry-run",
    assignee,
    filter,
    candidates: safeCandidates,
    deleted: [],
    failed: [],
    skippedUnsafe,
    remainingAfterDelete: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  console.log(`bitrix gz cleanup: mode=${report.mode}`);
  console.log(`assignee=${assignee.name} (${assignee.id})`);
  console.log(`candidates=${safeCandidates.length} skipped_unsafe=${skippedUnsafe.length}`);
  for (const lead of safeCandidates.slice(0, 10)) {
    console.log(`[candidate] lead ${lead.ID} | ${lead.ORIGIN_ID} | ${lead.TITLE ?? ""}`);
  }
  if (safeCandidates.length > 10) console.log(`[candidate] ... ${safeCandidates.length - 10} more`);

  if (skippedUnsafe.length > 0) {
    console.warn("Unsafe candidates were returned by Bitrix and will not be deleted.");
  }

  if (args.execute) {
    for (const lead of safeCandidates) {
      const id = String(lead.ID ?? "");
      if (!id) continue;
      try {
        await client.deleteLead(id);
        report.deleted.push({ id, originId: lead.ORIGIN_ID ?? null });
        console.log(`[deleted] lead ${id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ id, originId: lead.ORIGIN_ID ?? null, message });
        console.error(`[failed] lead ${id}: ${message}`);
      }
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
    report.remainingAfterDelete = (await client.listGzLeads(filter))
      .filter((lead) => isSafeGzLeadForAssignee(lead, assignee.id))
      .length;
    console.log(`remaining_after_delete=${report.remainingAfterDelete}`);
  } else {
    console.log("dry-run only: pass --execute to delete these leads");
  }

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
  fs.writeFileSync(args.reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`report=${args.reportPath}`);

  if (report.failed.length > 0 || report.skippedUnsafe.length > 0 || (args.execute && report.remainingAfterDelete !== 0)) {
    process.exitCode = 1;
  }
}

async function resolveUniqueUser(client: BitrixClient, fullName: string): Promise<{ id: string; name: string }> {
  const users = await client.searchUsers(fullName);
  const exact = findExactUsersByName(users, fullName);
  if (exact.length !== 1) {
    const found = users.map((user) => `${user.ID ?? "?"}:${formatBitrixUserName(user) || JSON.stringify(user)}`).join("; ");
    throw new Error(`Expected exactly one active Bitrix user named "${fullName}", found ${exact.length}. Candidates: ${found || "-"}`);
  }
  const user = exact[0];
  if (!user.ID) throw new Error(`Bitrix user "${fullName}" has no ID`);
  return { id: String(user.ID), name: formatBitrixUserName(user) };
}

class BitrixClient {
  private readonly baseUrl: string;

  constructor(webhookUrl: string) {
    this.baseUrl = webhookUrl.replace(/\/+$/, "");
  }

  async searchUsers(fullName: string): Promise<BitrixUserSummary[]> {
    const [name, ...lastNameParts] = fullName.trim().split(/\s+/);
    const lastName = lastNameParts.join(" ");
    const bodies = [
      { FILTER: { NAME: name, LAST_NAME: lastName, ACTIVE: true } },
      { FILTER: { NAME: name, LAST_NAME: lastName, ACTIVE: "Y" } },
      { filter: { NAME: name, LAST_NAME: lastName, ACTIVE: "Y" } }
    ];
    const users: BitrixUserSummary[] = [];
    for (const body of bodies) {
      for (const method of ["user.search", "user.get"]) {
        try {
          users.push(...await this.callPaged<BitrixUserSummary>(method, body));
        } catch (error) {
          console.warn(`bitrix user lookup via ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (users.length > 0) break;
    }
    return dedupeById(users);
  }

  async listGzLeads(filter: Record<string, string>): Promise<BitrixLeadCleanupCandidate[]> {
    return this.callPaged<BitrixLeadCleanupCandidate>("crm.lead.list", {
      order: { ID: "ASC" },
      filter,
      select: ["ID", "TITLE", "ORIGINATOR_ID", "ORIGIN_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "DATE_MODIFY"]
    });
  }

  async deleteLead(id: string): Promise<void> {
    await this.call("crm.lead.delete", { id });
  }

  private async callPaged<T>(method: string, body: Record<string, unknown>): Promise<T[]> {
    const result: T[] = [];
    let start: number | undefined = 0;
    while (start !== undefined) {
      const payload = await this.call(method, { ...body, start });
      if (Array.isArray(payload.result)) result.push(...payload.result as T[]);
      else if (payload.result && typeof payload.result === "object") result.push(...Object.values(payload.result) as T[]);
      start = typeof payload.next === "number" ? payload.next : undefined;
    }
    return result;
  }

  private async call(method: string, body: unknown): Promise<{ result: unknown; next?: number; error?: string; error_description?: string }> {
    const response = await fetch(`${this.baseUrl}/${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as { result: unknown; next?: number; error?: string; error_description?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error_description || payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }
}

function dedupeById<T extends { ID?: string | number }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const id = String(row.ID ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
