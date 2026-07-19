export interface RecaptchaV2Task {
  websiteURL: string;
  websiteKey: string;
}

export interface CapSolverClientOptions {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CapSolverResponse {
  errorId?: number;
  errorCode?: string | null;
  errorDescription?: string | null;
  taskId?: string;
  status?: string;
  solution?: { gRecaptchaResponse?: string };
}

export class CapSolverClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: CapSolverClientOptions) {
    if (!options.apiKey.trim()) throw new Error("CAPSOLVER_API_KEY is required");
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async solveRecaptchaV2(task: RecaptchaV2Task): Promise<string> {
    const created = await this.post("createTask", {
      clientKey: this.options.apiKey,
      task: { type: "ReCaptchaV2TaskProxyLess", websiteURL: task.websiteURL, websiteKey: task.websiteKey }
    });
    assertSuccessful(created, this.options.apiKey);
    if (!created.taskId) throw new Error("CapSolver did not return taskId");

    const startedAt = this.now();
    while (this.now() - startedAt < this.timeoutMs) {
      await this.sleep(this.pollIntervalMs);
      if (this.now() - startedAt >= this.timeoutMs) break;
      const result = await this.post("getTaskResult", { clientKey: this.options.apiKey, taskId: created.taskId });
      assertSuccessful(result, this.options.apiKey);
      if (result.status === "failed") throw apiError(result, "task failed", this.options.apiKey);
      if (result.status === "ready") {
        const token = result.solution?.gRecaptchaResponse;
        if (!token) throw new Error("CapSolver returned an empty solution");
        return token;
      }
    }
    throw new Error("CapSolver polling timeout");
  }

  private async post(endpoint: string, body: unknown): Promise<CapSolverResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.capsolver.com/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      if (/abort|timeout/i.test(String(error))) throw new Error("CapSolver request timeout");
      throw new Error("CapSolver request failed");
    }
    if (!response.ok) throw new Error(`CapSolver HTTP ${response.status}`);
    try { return await response.json() as CapSolverResponse; }
    catch { throw new Error("CapSolver returned invalid JSON"); }
  }
}

function assertSuccessful(response: CapSolverResponse, secret: string): void {
  if (response.errorId) throw apiError(response, "API error", secret);
}

function apiError(response: CapSolverResponse, fallback: string, secret: string): Error {
  const code = safePart(response.errorCode) || fallback;
  const description = redact(safePart(response.errorDescription), secret);
  return new Error(`CapSolver ${code}${description ? `: ${description}` : ""}`);
}

function safePart(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]/g, " ").slice(0, 300) : "";
}
function redact(value: string, secret: string): string { return secret ? value.split(secret).join("[redacted]") : value; }
