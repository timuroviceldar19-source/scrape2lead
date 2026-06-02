import { randomUUID } from "node:crypto";
import type { AdapterRegistry } from "../adapters/registry.js";
import { logger } from "../logger.js";
import type { CompanyTaskRow, Lead, RawCompanyCard, RuntimeConfig, ISourceAdapter } from "../types.js";
import { Storage } from "../storage/storage.js";
import { exportLeads } from "../export/exporter.js";
import { RateLimiter } from "./rateLimiter.js";
import { computeBackoffMs, type BackoffOptions } from "./backoff.js";
import type { ProxyRotator } from "../proxy/proxyRotator.js";

const DEFAULT_LEASE_MS = 60_000;
const EMPTY_POLL_MS = 250;

export interface JobManagerOptions {
  leaseMs?: number;
  backoff?: BackoffOptions;
  emptyPollMs?: number;
  /**
   * Interval in ms for the periodic lease-recovery watchdog.
   * When set, `storage.recoverExpiredLeases()` is called at this cadence
   * throughout `run()` so tasks whose lease expires mid-job are returned to
   * the queue without restarting the process.
   * Default: undefined (disabled — only startup recovery runs).
   */
  leaseWatchdogMs?: number;
}

export class JobManager {
  private readonly limiter: RateLimiter;
  private readonly leaseMs: number;
  private readonly backoff: BackoffOptions;
  private readonly emptyPollMs: number;
  private readonly leaseWatchdogMs: number | undefined;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly registry: AdapterRegistry,
    private readonly storage: Storage,
    private readonly rotator?: ProxyRotator,
    options?: JobManagerOptions
  ) {
    this.limiter = new RateLimiter(config.delayRangeMs);
    this.leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    this.backoff = options?.backoff ?? {};
    this.emptyPollMs = options?.emptyPollMs ?? EMPTY_POLL_MS;
    this.leaseWatchdogMs = options?.leaseWatchdogMs;
  }

  async run(): Promise<{ leads: Lead[]; csvPath: string; xlsxPath: string; jobId: string; status: string }> {
    // Startup lease recovery — always runs once before workers begin.
    const recovered = this.storage.recoverExpiredLeases();
    if (recovered > 0) {
      logger.info("recovered expired leases", { recovered });
    }

    // Periodic watchdog — only active when leaseWatchdogMs is configured.
    let watchdogHandle: ReturnType<typeof setInterval> | undefined;
    if (this.leaseWatchdogMs !== undefined) {
      let watchdogBusy = false;
      watchdogHandle = setInterval(() => {
        if (watchdogBusy) return;
        watchdogBusy = true;
        try {
          const n = this.storage.recoverExpiredLeases();
          if (n > 0) logger.info("watchdog recovered expired leases", { recovered: n });
        } finally {
          watchdogBusy = false;
        }
      }, this.leaseWatchdogMs);
    }

    try {
      const adapter = this.registry.resolve(this.config.source);
      const jobInput = {
        source: this.config.source,
        city: this.config.geo,
        category: this.config.category
      };
      const resumable = this.storage.findResumableParseJob(jobInput);
      const jobId = resumable?.id ?? this.storage.createParseJob(jobInput);
      if (resumable) {
        this.storage.setParseJobStatus(jobId, "running");
        logger.info("job resumed", {
          jobId,
          source: jobInput.source,
          geo: jobInput.city,
          category: jobInput.category,
          openTasks: this.storage.countOpenTasks(jobId)
        });
      } else {
        logger.info("job started", { jobId, ...jobInput });
      }

      const cards = await adapter.searchCompanies(this.config);
      this.storage.updateParseJobTotalFound(jobId, cards.length);
      logger.info("cards discovered", { jobId, count: cards.length });

      const cardMap = new Map<string, RawCompanyCard>();
      for (const card of cards) {
        cardMap.set(card.externalId, card);
        this.storage.enqueueCompanyTask({
          parseJobId: jobId,
          source: adapter.source,
          externalId: card.externalId
        });
      }

      const concurrency = Math.max(1, this.config.concurrency);
      const workers = Array.from({ length: concurrency }, (_, i) =>
        this.runWorker(`worker-${i}-${randomUUID().slice(0, 6)}`, jobId, cardMap, adapter)
      );
      await Promise.all(workers);

      const status = this.storage.finalizeParseJob(jobId);

      const leads = this.storage.listLeads();
      const exported = await exportLeads(leads, this.config.exportDir);
      logger.info("job completed", { jobId, status, leads: leads.length, ...exported });
      return { leads, ...exported, jobId, status };
    } finally {
      clearInterval(watchdogHandle);
    }
  }

  private async runWorker(
    workerId: string,
    jobId: string,
    cardMap: Map<string, RawCompanyCard>,
    adapter: ISourceAdapter
  ): Promise<void> {
    while (true) {
      const task = this.storage.claimNextTask({
        parseJobId: jobId,
        workerId,
        leaseMs: this.leaseMs
      });
      if (!task) {
        if (this.storage.countOpenTasks(jobId) === 0) return;
        await sleep(this.emptyPollMs);
        continue;
      }
      await this.processTask(workerId, jobId, task, cardMap, adapter);
    }
  }

  private async processTask(
    workerId: string,
    jobId: string,
    task: CompanyTaskRow,
    cardMap: Map<string, RawCompanyCard>,
    adapter: ISourceAdapter
  ): Promise<void> {
    const card = cardMap.get(task.external_id);
    if (!card) {
      this.storage.markTaskFailed(task.id, "card reference missing");
      this.storage.saveAttempt({
        jobId,
        source: adapter.source,
        externalId: task.external_id,
        status: "failed",
        message: "card reference missing",
        companyTaskId: task.id,
        attemptNo: task.attempts,
        errorType: "missing_card",
        proxyId: this.resolveProxyId()
      });
      return;
    }

    await this.limiter.wait();
    const startedAt = Date.now();
    try {
      const detail = await adapter.getCardDetail(card);
      this.storage.saveRawSnapshot({
        companyTaskId: task.id,
        source: adapter.source,
        externalId: card.externalId,
        kind: "json",
        purpose: "recent",
        payload: detail.payload
      });
      const contacts = await adapter.getContacts(detail);
      this.storage.saveRawSnapshot({
        companyTaskId: task.id,
        source: adapter.source,
        externalId: card.externalId,
        kind: "json",
        purpose: "recent",
        payload: contacts.payload
      });
      const lead = adapter.normalize(detail, contacts);
      this.storage.upsertLead(lead);
      const isPartial = lead.incomplete;
      if (isPartial) {
        this.storage.markTaskPartial(task.id);
      } else {
        this.storage.markTaskSuccess(task.id);
      }
      this.storage.saveAttempt({
        jobId,
        source: adapter.source,
        externalId: card.externalId,
        status: isPartial ? "partial" : "success",
        companyTaskId: task.id,
        attemptNo: task.attempts,
        durationMs: Date.now() - startedAt,
        proxyId: this.resolveProxyId()
      });
      await this.rotator?.tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorType = classifyError(message);
      const blocked = errorType === "blocked";
      const isDeletedCard = errorType === "deleted_card";
      const isNoData = errorType === "no_data";
      const maxAttempts = this.config.maxRetries + 1;

      // Derive attempt result from error class before persisting.
      const attemptStatus = isDeletedCard ? "failed" : isNoData ? "partial" : blocked ? "blocked" : "error";

      this.storage.saveAttempt({
        jobId,
        source: adapter.source,
        externalId: card.externalId,
        status: attemptStatus,
        message,
        companyTaskId: task.id,
        attemptNo: task.attempts,
        errorType,
        durationMs: Date.now() - startedAt,
        proxyId: this.resolveProxyId()
      });

      // Non-retryable: card removed from source → terminal failed, no retry.
      if (isDeletedCard) {
        this.storage.markTaskFailed(task.id, message);
        logger.warn("task deleted card terminal", { workerId, taskId: task.id, attempts: task.attempts, message });
        return;
      }

      // Non-retryable: source returned no usable data → terminal partial, no retry.
      if (isNoData) {
        this.storage.markTaskPartial(task.id);
        logger.info("task no data terminal", { workerId, taskId: task.id, attempts: task.attempts, message });
        return;
      }

      if (blocked) {
        // Persist evidence snapshot + captcha event for every blocked detection.
        const isCaptcha = message.toLowerCase().includes("captcha");
        const snapshotId = this.storage.saveRawSnapshot({
          companyTaskId: task.id,
          source: adapter.source,
          externalId: card.externalId,
          kind: "json",
          purpose: isCaptcha ? "captcha" : "error",
          payload: { message, errorType, externalId: card.externalId }
        });
        this.storage.saveCaptchaEvent({
          source: adapter.source,
          action: isCaptcha ? "captcha_detected" : "blocked_detected",
          companyTaskId: task.id,
          snapshotId,
          url: card.url ?? null,
          proxyId: this.resolveProxyId() ?? null
        });

        if (task.attempts >= maxAttempts) {
          this.storage.markTaskFailed(task.id, message);
          logger.warn("task blocked terminal", { workerId, taskId: task.id, attempts: task.attempts, message });
          return;
        }
        this.storage.markTaskBlocked(task.id, message);
        await this.rotator?.rotate("blocked");
        const delayMs = computeBackoffMs(task.attempts, this.backoff);
        this.storage.scheduleTaskRetry(
          task.id,
          message,
          new Date(Date.now() + delayMs).toISOString()
        );
        return;
      }

      if (task.attempts >= maxAttempts) {
        this.storage.markTaskFailed(task.id, message);
        logger.warn("task failed terminal", { workerId, taskId: task.id, attempts: task.attempts, message });
        return;
      }

      const delayMs = computeBackoffMs(task.attempts, this.backoff);
      const nextRunAt = new Date(Date.now() + delayMs).toISOString();
      this.storage.scheduleTaskRetry(task.id, message, nextRunAt);
      logger.info("task retry scheduled", { workerId, taskId: task.id, attempts: task.attempts, nextRunAt, message });
    }
  }

  private resolveProxyId(): string | undefined {
    const s = this.rotator?.getCurrentState();
    if (!s) return undefined;
    return s.proxyChannel ?? s.proxy ?? undefined;
  }
}

function classifyError(message: string): string {
  const lower = message.toLowerCase();
  // blocked / rate-limited — must be checked before deleted_card so "403" wins over any overlap
  if (lower.includes("captcha") || lower.includes("403") || lower.includes("429") || lower.includes("blocked")) {
    return "blocked";
  }
  // card was removed from source (non-retryable → fail immediately)
  if (lower.includes("404") || lower.includes("not found") || lower.includes("deleted") || lower.includes("removed")) {
    return "deleted_card";
  }
  // source returned empty/no-data payload (non-retryable → partial immediately)
  if (
    lower.includes("no data") ||
    lower.includes("no_data") ||
    lower.includes("empty response") ||
    lower.includes("no contacts") ||
    lower.includes("no details")
  ) {
    return "no_data";
  }
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("selector")) return "selector";
  return "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
