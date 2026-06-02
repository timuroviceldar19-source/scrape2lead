import type { ProxyRotator } from "../proxy/proxyRotator.js";
import type { RateLimitPolicy } from "../types.js";

/**
 * Width of the sliding window for per-minute limits. Defined as a constant
 * (rather than a policy field) to match the TZ wording — the limits are
 * explicitly "per minute".
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Maximum number of `rotator.rotate("cards_per_proxy_cap")` calls allowed
 * in a single `acquireCardStart()` invocation. Guards against the case
 * where the rotation API keeps returning the same over-burdened proxy (or
 * silently fails to update `cardsOnIp`) — without this cap the worker
 * would loop forever.
 */
export const MAX_PROXY_ROTATION_ATTEMPTS = 5;

/**
 * Indirection over `Date.now` and `setTimeout` so unit tests can drive the
 * limiter deterministically. The default implementation is the standard
 * Node.js clock and is used by the JobManager at runtime.
 */
export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/**
 * Stable bucket id for the request budget when no proxy rotator is present.
 * Mirrors `JobManager.resolveProxyId()`'s fallback (`proxyChannel ?? proxy ?? undefined`)
 * normalised to the literal `"direct"`.
 */
export const DIRECT_PROXY_BUCKET = "direct";

/**
 * Centralised enforcement of the rate-limit policy defined in
 * {@link RateLimitPolicy}. The pre-policy `delayRangeMs` jitter is preserved
 * verbatim as {@link RateLimiter.wait}; the new gates layer on top of it.
 *
 * Persistent caps (session duration, per-session card count) are *checks* —
 * once tripped, the caller must stop starting new cards. Transient caps
 * (per-minute, per-proxy cards, per-proxy requests) are *atomic acquires* —
 * the slot is reserved in a single synchronous step so concurrent workers
 * cannot all pass the empty-window check before any of them records.
 */
export class RateLimiter {
  private readonly cardStartTimestamps: number[] = [];
  private readonly requestTimestampsByProxy = new Map<string, number[]>();
  private readonly sessionStartTime: number;
  private reservedSessionCards = 0;

  constructor(
    private readonly delayRangeMs: [number, number],
    private readonly policy: RateLimitPolicy = {},
    private readonly rotator?: ProxyRotator,
    clock: RateLimiterClock = defaultClock
  ) {
    this.clock = clock;
    this.sessionStartTime = clock.now();
  }

  private readonly clock: RateLimiterClock;

  /**
   * Pre-existing inter-action jitter. Behaviour is unchanged from the
   * pre-policy implementation: random value in `[min, max)` (or `min` when
   * `min === max`).
   */
  async wait(): Promise<void> {
    const [min, max] = this.delayRangeMs;
    const delay = Math.floor(min + Math.random() * Math.max(1, max - min));
    await this.clock.sleep(delay);
  }

  /**
   * Persistent cap check that the worker loop must consult *before* claiming
   * a new task. When `ok: false`, the caller should stop starting new cards
   * (in-flight work is allowed to finish cleanly). Must also be rechecked
   * after a transient wait (e.g. {@link acquireCardStart}) since the wait
   * itself may have crossed the session-duration boundary.
   */
  canStartCard(): { ok: true } | { ok: false; reason: "max_session_duration" } {
    if (this.policy.maxSessionDurationMs !== undefined) {
      const elapsed = this.clock.now() - this.sessionStartTime;
      if (elapsed >= this.policy.maxSessionDurationMs) {
        return { ok: false, reason: "max_session_duration" };
      }
    }
    return { ok: true };
  }

  /**
   * Atomic reservation of one slot in the per-session card budget. The
   * caller is expected to pair a successful reservation with
   * {@link releaseSessionCard} in a `finally` block so a thrown adapter
   * does not leak the slot.
   *
   * The check considers both:
   * - the durable count (supplied by the caller via the callback — every
   *   completed attempt inserts a row in `parse_attempts`, which survives
   *   process restarts and is the source of truth for resumed jobs), and
   * - the in-flight reservation counter (`reservedSessionCards`), which
   *   prevents overshoot under `concurrency > 1` between the durable
   *   write and the next read.
   *
   * Returns `true` if a slot was reserved, `false` if the cap is already
   * reached. When `maxCardsPerSession` is unset, every call succeeds and
   * the counter stays at 0.
   *
   * The durable-count callback may return a `Promise<number>` — async
   * storage backends (e.g. Postgres) need to await a round-trip to read
   * the source of truth. When the callback resolves, the comparison
   * happens synchronously before the reservation is taken, so the slot is
   * never released back to the pool in a partially-applied state.
   */
  async tryReserveSessionCard(getDurableCompletedCount: () => number | Promise<number>): Promise<boolean> {
    if (this.policy.maxCardsPerSession === undefined) return true;
    const durable = await getDurableCompletedCount();
    if (this.reservedSessionCards + durable >= this.policy.maxCardsPerSession) {
      return false;
    }
    this.reservedSessionCards += 1;
    return true;
  }

  /**
   * Release a previously-reserved slot. Safe to call even when no policy
   * is set (no-op) and guarded against underflow if invoked more often
   * than `tryReserveSessionCard` succeeded.
   */
  releaseSessionCard(): void {
    if (this.policy.maxCardsPerSession === undefined) return;
    if (this.reservedSessionCards > 0) this.reservedSessionCards -= 1;
  }

  /**
   * Atomically acquire a slot in the per-minute card-start window and
   * ensure the current proxy is below the per-proxy card cap.
   *
   * Replaces the previous separate `waitForCardStart()` / `recordCardStart()`
   * pair. The window check and the timestamp push happen inside the same
   * synchronous block (no `await` between them), so concurrent workers
   * cannot all pass the empty-window check before any of them records —
   * which would otherwise let `concurrency > 1` exceed `maxCardsPerMinute`.
   *
   * - `maxCardsPerMinute`: sliding 60s window. Waits until the window has
   *   room, then atomically reserves one slot.
   * - `maxCardsPerProxy`: rotates the proxy while `cardsOnIp >= cap`; throws
   *   after {@link MAX_PROXY_ROTATION_ATTEMPTS} failed rotations.
   *
   * Throws when the per-proxy rotation overflows. The caller is expected
   * to catch and react — typically by exiting the worker loop cleanly.
   */
  async acquireCardStart(): Promise<void> {
    const minuteCap = this.policy.maxCardsPerMinute;
    const proxyCap = this.policy.maxCardsPerProxy;
    const rotator = this.rotator;

    const hasMinuteGate = minuteCap !== undefined;
    const hasProxyGate = proxyCap !== undefined && rotator !== undefined;
    if (!hasMinuteGate && !hasProxyGate) return;

    while (true) {
      const now = this.clock.now();

      // Per-minute gate: drop expired entries, then check capacity.
      // The reservation push happens AFTER the rotation block so a slot
      // is only consumed when the caller is actually about to start the
      // card (i.e. rotation did not throw and we are returning).
      if (hasMinuteGate) {
        const cutoff = now - RATE_LIMIT_WINDOW_MS;
        while (
          this.cardStartTimestamps.length > 0 &&
          this.cardStartTimestamps[0] <= cutoff
        ) {
          this.cardStartTimestamps.shift();
        }
        if (this.cardStartTimestamps.length >= minuteCap) {
          const waitMs = this.cardStartTimestamps[0] + RATE_LIMIT_WINDOW_MS - now;
          await this.clock.sleep(Math.max(1, waitMs));
          continue;
        }
      }

      // Per-proxy rotation: keep rotating until cardsOnIp is below the cap,
      // or throw after MAX_PROXY_ROTATION_ATTEMPTS to prevent infinite loops.
      if (hasProxyGate) {
        let attempts = 0;
        while (rotator.getCurrentState().cardsOnIp >= proxyCap) {
          if (attempts >= MAX_PROXY_ROTATION_ATTEMPTS) {
            throw new Error(
              `rate limit: max_cards_per_proxy — ${MAX_PROXY_ROTATION_ATTEMPTS} rotation attempts did not lower cardsOnIp below the cap`
            );
          }
          await rotator.rotate("cards_per_proxy_cap");
          attempts += 1;
        }
      }

      // Atomic reservation: the check above and the push here are in the
      // same synchronous block (no `await` between them), so concurrent
      // workers cannot interleave between "see room" and "consume room".
      if (hasMinuteGate) {
        this.cardStartTimestamps.push(this.clock.now());
      }
      return;
    }
  }

  /**
   * Atomically acquire a slot in the per-proxy request budget.
   *
   * Replaces the previous separate `waitForRequest()` / `recordRequest()`
   * pair. The bucket check and the timestamp push happen inside the same
   * synchronous block, so concurrent workers cannot all pass the
   * empty-bucket check before any of them records.
   *
   * The slot is reserved *before* the caller makes the adapter request,
   * so a failed request still consumes a slot (the timestamp is in the
   * bucket regardless of call outcome).
   *
   * `proxyId` is the bucket key (`proxyChannel ?? proxy ?? "direct"`).
   */
  async acquireRequest(proxyId: string): Promise<void> {
    const cap = this.policy.maxRequestsPerMinutePerProxy;
    if (cap === undefined) return;
    const bucket = this.bucketFor(proxyId);

    while (true) {
      const now = this.clock.now();
      const cutoff = now - RATE_LIMIT_WINDOW_MS;
      while (bucket.length > 0 && bucket[0] <= cutoff) {
        bucket.shift();
      }
      if (bucket.length < cap) {
        // Atomic reservation: no `await` between the capacity check and
        // the push, so concurrent workers on the same bucket cannot
        // overshoot the cap.
        bucket.push(now);
        return;
      }
      const waitMs = bucket[0] + RATE_LIMIT_WINDOW_MS - now;
      await this.clock.sleep(Math.max(1, waitMs));
    }
  }

  /** Lazily allocate the per-proxy bucket so `Map.size` reflects actual use. */
  private bucketFor(proxyId: string): number[] {
    let list = this.requestTimestampsByProxy.get(proxyId);
    if (!list) {
      list = [];
      this.requestTimestampsByProxy.set(proxyId, list);
    }
    return list;
  }
}
