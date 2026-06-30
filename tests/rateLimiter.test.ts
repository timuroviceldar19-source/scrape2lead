import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIRECT_PROXY_BUCKET,
  MAX_PROXY_ROTATION_ATTEMPTS,
  RateLimiter,
  RATE_LIMIT_WINDOW_MS
} from "../src/core/rateLimiter.js";
import type { RateLimiterClock } from "../src/core/rateLimiter.js";
import type { ProxyRotator, ProxyRuntimeState } from "../src/proxy/proxyRotator.js";

function makeFakeRotator(opts: {
  cardsOnIp?: number;
  /** When true (default), rotate() resets cardsOnIp to 0. */
  resetOnRotate?: boolean;
  /** Proxy channel reported in getCurrentState. */
  channel?: string | null;
} = {}): ProxyRotator & { rotate: ReturnType<typeof vi.fn>; rotateCalls: () => number } {
  let cardsOnIp = opts.cardsOnIp ?? 0;
  const rotate = vi.fn(async (_reason: string) => {
    if (opts.resetOnRotate !== false) cardsOnIp = 0;
  });
  return {
    getCurrentState: (): ProxyRuntimeState => ({
      proxy: "http://rotator.test:8080",
      proxyChannel: opts.channel ?? "ch-test",
      ip: "1.2.3.4",
      cardsOnIp
    }),
    rotate,
    tick: vi.fn(async () => {
      cardsOnIp += 1;
    }),
    rotateCalls: () => rotate.mock.calls.length
  } as unknown as ProxyRotator & { rotate: ReturnType<typeof vi.fn>; rotateCalls: () => number };
}

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("wait() — preserved delayRangeMs jitter", () => {
    it("resolves after a small delay with range [0, 0]", async () => {
      // With min=max=0, the original formula is delay = floor(0 + 0 * 1) = 0,
      // so the limiter schedules a 0ms setTimeout. With fake timers we must
      // advance to let that timer fire.
      const rl = new RateLimiter([0, 0]);
      const p = rl.wait();
      await vi.advanceTimersByTimeAsync(1);
      await p;
    });

    it("preserves the original jitter behaviour when no policy is set", async () => {
      // delayRangeMs [10, 20] without policy must behave like the pre-policy
      // implementation: a single setTimeout of 10..19 ms.
      const rl = new RateLimiter([10, 20]);
      const p = rl.wait();
      // The limiter slept for some 10..19 ms; advance just past the upper bound.
      await vi.advanceTimersByTimeAsync(20);
      await p;
    });
  });

  describe("canStartCard() — max_session_duration", () => {
    it("returns ok=true when no policy is set, regardless of elapsed time", async () => {
      const rl = new RateLimiter([0, 0]);
      await vi.advanceTimersByTimeAsync(10 ** 9);
      expect(rl.canStartCard()).toEqual({ ok: true });
    });

    it("returns ok=true while elapsed time is under the cap", async () => {
      const rl = new RateLimiter([0, 0], { maxSessionDurationMs: 1000 });
      await vi.advanceTimersByTimeAsync(500);
      expect(rl.canStartCard()).toEqual({ ok: true });
    });

    it("returns ok=false once the cap is reached", async () => {
      const rl = new RateLimiter([0, 0], { maxSessionDurationMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = rl.canStartCard();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("max_session_duration");
    });
  });

  describe("acquireCardStart() — max_cards_per_minute", () => {
    it("returns immediately when no policy is set", async () => {
      const rl = new RateLimiter([0, 0]);
      await rl.acquireCardStart(); // resolves without advancing time
    });

    it("does not block while the sliding window has room", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerMinute: 3 });
      await rl.acquireCardStart();
      await rl.acquireCardStart();
      // 2 of 3 used — third still has room.
      await rl.acquireCardStart();
    });

    it("blocks the third acquire when window is full", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerMinute: 2 });
      await rl.acquireCardStart();
      await rl.acquireCardStart();

      let resolved = false;
      const p = rl.acquireCardStart().then(() => {
        resolved = true;
      });
      // Drain microtasks — limiter is parked inside clock.sleep.
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Advance just shy of the 60s window — gate still closed.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS - 1);
      expect(resolved).toBe(false);

      // Advance to the boundary — oldest entry slides out and the gate opens.
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(resolved).toBe(true);
    });

    it("honours the sliding window (old entries are dropped, not all entries)", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerMinute: 2 });
      // First start at t=0.
      await rl.acquireCardStart();
      // Second start at t=10s.
      await vi.advanceTimersByTimeAsync(10_000);
      await rl.acquireCardStart();

      // Third acquire attempted at t=10s — window has 2 entries, blocks until
      // the t=0 entry slides out at t=60s (i.e. 50s of sleep from here).
      let resolved = false;
      const p = rl.acquireCardStart().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(49_999);
      expect(resolved).toBe(false);

      // Crossing t=60s drops the t=0 entry — only the t=10s entry remains,
      // so the gate opens even though the t=10s entry is still in the window.
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(resolved).toBe(true);
    });

    it("atomic check+reserve: concurrency > 1 cannot overshoot the cap", async () => {
      // Concurrency > 1 stress test for the atomic acquisition. With the old
      // separate wait+record design, the `await` inside waitForCardStart
      // created a microtask boundary that let multiple workers pass the
      // empty-window check before any of them recorded, overshooting the
      // cap. The atomic check+reserve closes that gap: only `cap`
      // acquisitions succeed synchronously, the rest park on the window.
      const rl = new RateLimiter([0, 0], { maxCardsPerMinute: 2 });
      const promises = Array.from({ length: 5 }, () => rl.acquireCardStart());

      // Drain microtasks so the synchronous check+reserve block runs for
      // all 5 acquisitions. The 2 that find room push their timestamp
      // immediately; the other 3 are parked inside clock.sleep.
      await vi.advanceTimersByTimeAsync(0);

      const timestamps = (rl as unknown as { cardStartTimestamps: number[] }).cardStartTimestamps;
      // Exactly 2 entries (the cap) — not 5.
      expect(timestamps).toHaveLength(2);

      // Clean up: advance timers far enough to let the 3 parked acquires
      // resolve. The window slides multiple times so each parked acquire
      // finds room on its next wake.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS * 3);
      await Promise.all(promises);
    });

    it("atomic check+reserve: pushes the timestamp exactly once per successful acquire", async () => {
      // Sanity check that the synchronous block pushes a single timestamp
      // per acquire (no double-push, no missed push) when there is room.
      const rl = new RateLimiter([0, 0], { maxCardsPerMinute: 5 });
      for (let i = 0; i < 5; i += 1) {
        await rl.acquireCardStart();
      }
      const timestamps = (rl as unknown as { cardStartTimestamps: number[] }).cardStartTimestamps;
      expect(timestamps).toHaveLength(5);
    });
  });

  describe("acquireCardStart() — max_cards_per_proxy", () => {
    it("rotates the proxy when current cardsOnIp >= cap", async () => {
      const rotator = makeFakeRotator({ cardsOnIp: 3 });
      const rl = new RateLimiter([0, 0], { maxCardsPerProxy: 3 }, rotator);

      // acquireCardStart is non-blocking when rotation succeeds: it awaits
      // the rotator's promise, then re-checks the state.
      const p = rl.acquireCardStart();
      // Drain microtasks so the await on rotator.rotate() resumes and the
      // limiter re-checks the (now reset) cardsOnIp.
      await vi.advanceTimersByTimeAsync(0);
      await p;

      expect(rotator.rotate).toHaveBeenCalledWith("cards_per_proxy_cap");
    });

    it("does not rotate when current cardsOnIp is below the cap", async () => {
      const rotator = makeFakeRotator({ cardsOnIp: 1 });
      const rl = new RateLimiter([0, 0], { maxCardsPerProxy: 3 }, rotator);
      await rl.acquireCardStart();
      expect(rotator.rotate).not.toHaveBeenCalled();
    });

    it("is a no-op when no rotator is configured", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerProxy: 3 });
      await rl.acquireCardStart(); // does not throw
    });

    it("loops rotation if the new proxy still has cardsOnIp at the cap", async () => {
      let cardsOnIp = 5;
      const rotate = vi.fn(async () => {
        // Pretend the rotation API always returns the same over-burdened
        // proxy. The limiter must keep rotating until a fresh proxy arrives.
        if (rotate.mock.calls.length < 2) return;
        cardsOnIp = 0;
      });
      const rotator = {
        getCurrentState: (): ProxyRuntimeState => ({
          proxy: "http://rotator.test:8080",
          proxyChannel: "ch-test",
          ip: "1.2.3.4",
          cardsOnIp
        }),
        rotate,
        tick: vi.fn(async () => {})
      } as unknown as ProxyRotator;

      const rl = new RateLimiter([0, 0], { maxCardsPerProxy: 3 }, rotator);
      await rl.acquireCardStart();
      expect(rotate).toHaveBeenCalledTimes(2);
    });
  });

  describe("acquireRequest() — per-proxy budget", () => {
    it("returns immediately when no policy is set", async () => {
      const rl = new RateLimiter([0, 0]);
      await rl.acquireRequest("ch-a");
    });

    it("does not block while the proxy bucket has room", async () => {
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 3 });
      await rl.acquireRequest("ch-a");
      await rl.acquireRequest("ch-a");
      // 2 of 3 used — third still has room.
      await rl.acquireRequest("ch-a");
    });

    it("blocks when a proxy bucket is full", async () => {
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 2 });
      await rl.acquireRequest("ch-a");
      await rl.acquireRequest("ch-a");

      let resolved = false;
      const p = rl.acquireRequest("ch-a").then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS);
      await p;
      expect(resolved).toBe(true);
    });

    it("isolates buckets per proxy id (one bucket full does not block another)", async () => {
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 2 });
      await rl.acquireRequest("ch-a");
      await rl.acquireRequest("ch-a");
      // ch-a is now full. ch-b has its own bucket — must resolve immediately.
      const p = rl.acquireRequest("ch-b");
      await vi.advanceTimersByTimeAsync(0);
      await p;
    });

    it("uses a stable direct bucket for the no-rotator path", async () => {
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 2 });
      await rl.acquireRequest(DIRECT_PROXY_BUCKET);
      await rl.acquireRequest(DIRECT_PROXY_BUCKET);

      let resolved = false;
      const p = rl.acquireRequest(DIRECT_PROXY_BUCKET).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS);
      await p;
      expect(resolved).toBe(true);
    });

    it("atomic check+reserve: concurrency > 1 cannot overshoot the per-proxy cap", async () => {
      // Concurrency > 1 stress test for the per-proxy request budget. With
      // the old separate wait+record design, the `await` inside
      // waitForRequest created a microtask boundary that let multiple
      // workers pass the empty-bucket check before any of them recorded.
      // The atomic check+reserve closes that gap.
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 4 });
      const promises = Array.from({ length: 10 }, () => rl.acquireRequest("ch-bucket"));

      // Drain microtasks so the synchronous check+reserve runs for all 10.
      await vi.advanceTimersByTimeAsync(0);

      const bucket = (rl as unknown as { requestTimestampsByProxy: Map<string, number[]> })
        .requestTimestampsByProxy.get("ch-bucket");
      // Exactly 4 entries (the cap) — not 10.
      expect(bucket).toHaveLength(4);

      // Clean up.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS * 3);
      await Promise.all(promises);
    });

    it("atomic check+reserve: concurrency > 1 on independent buckets do not interfere", async () => {
      // The atomic check is per-bucket, so concurrent acquires on different
      // proxy ids should each see their own (empty) bucket and reserve
      // immediately.
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 2 });
      const promises = [
        rl.acquireRequest("ch-a"),
        rl.acquireRequest("ch-b"),
        rl.acquireRequest("ch-c")
      ];
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(promises);

      const map = (rl as unknown as { requestTimestampsByProxy: Map<string, number[]> })
        .requestTimestampsByProxy;
      expect(map.get("ch-a")).toHaveLength(1);
      expect(map.get("ch-b")).toHaveLength(1);
      expect(map.get("ch-c")).toHaveLength(1);
    });

    it("failed request: the slot is already reserved before the adapter call is made", async () => {
      // The slot is reserved atomically by acquireRequest *before* the
      // caller makes the adapter request. A throw from the adapter does
      // not release the slot — the timestamp is already in the bucket.
      // This is the in-process equivalent of the JobManager-level test
      // "failed getCardDetail still consumes a request slot".
      const rl = new RateLimiter([0, 0], { maxRequestsPerMinutePerProxy: 2 });
      await rl.acquireRequest("ch-a");
      // 2nd reserve succeeds; the caller then "makes the adapter call"
      // which throws. The slot must still be consumed.
      try {
        await rl.acquireRequest("ch-a");
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _adapterCallThatMightThrow = (() => {
          throw new Error("HTTP 500 boom");
        })();
        void _adapterCallThatMightThrow;
      } catch {
        // adapter threw — slot is still consumed
      }

      const bucket = (rl as unknown as { requestTimestampsByProxy: Map<string, number[]> })
        .requestTimestampsByProxy.get("ch-a");
      // Both slots consumed regardless of the throw.
      expect(bucket).toHaveLength(2);

      // A 3rd acquire on the same bucket must block (cap of 2 is full).
      let resolved = false;
      const p = rl.acquireRequest("ch-a").then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS);
      await p;
      expect(resolved).toBe(true);
    });
  });

  describe("clock injection", () => {
    it("uses the supplied clock for canStartCard and gating", async () => {
      const fakeNow = { value: 0 };
      const clock: RateLimiterClock = {
        now: () => fakeNow.value,
        sleep: () => Promise.resolve()
      };
      const rl = new RateLimiter([0, 0], { maxSessionDurationMs: 100 }, undefined, clock);
      fakeNow.value = 50;
      expect(rl.canStartCard().ok).toBe(true);
      fakeNow.value = 100;
      expect(rl.canStartCard().ok).toBe(false);
    });
  });

  describe("tryReserveSessionCard() / releaseSessionCard() — atomic concurrency-safe cap", () => {
    it("returns true and never blocks when no policy is set", async () => {
      const rl = new RateLimiter([0, 0]);
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
      expect(await rl.tryReserveSessionCard(() => 9999)).toBe(true);
      // release is a no-op when the policy is unset.
      rl.releaseSessionCard();
      rl.releaseSessionCard();
    });

    it("caps the number of in-flight reservations, not just durable completions", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerSession: 3 });
      // Durable count stays at 0 (no completions yet) — but reservations are
      // the only thing that matters for the in-process cap.
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
      // 4th call must fail even though durable count is still 0.
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(false);
    });

    it("considers durable completions so resumed jobs honour the cap", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerSession: 3 });
      // Pretend the durable layer already recorded 2 completed attempts
      // (e.g. from a previous run that resumed).
      expect(await rl.tryReserveSessionCard(() => 2)).toBe(true);
      // durable=2 + reserved=1 = 3 → at the cap.
      expect(await rl.tryReserveSessionCard(() => 2)).toBe(false);
    });

    it("releases a slot so a subsequent reservation can succeed", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerSession: 1 });
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(false);
      rl.releaseSessionCard();
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
    });

    it("releaseSessionCard is safe to over-invoke (no negative counter)", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerSession: 5 });
      // No reservation in flight — calling release must not underflow.
      rl.releaseSessionCard();
      rl.releaseSessionCard();
      // The limiter still works normally.
      expect(await rl.tryReserveSessionCard(() => 0)).toBe(true);
    });

    it("queries the durable callback on every call (live count)", async () => {
      const rl = new RateLimiter([0, 0], { maxCardsPerSession: 2 });
      let durable = 0;
      const get = () => durable;
      // 0 reserved + 0 durable = 0 → reserve, reserved=1.
      expect(await rl.tryReserveSessionCard(get)).toBe(true);
      // 1 reserved + 0 durable = 1 → reserve, reserved=2.
      expect(await rl.tryReserveSessionCard(get)).toBe(true);
      // 2 reserved + 0 durable = 2 → at the cap, reject.
      expect(await rl.tryReserveSessionCard(get)).toBe(false);
      // Simulate a previous run that already wrote 1 attempt to storage.
      durable = 1;
      // 2 reserved + 1 durable = 3 → over the cap, reject.
      expect(await rl.tryReserveSessionCard(get)).toBe(false);
      // Free one in-flight slot.
      rl.releaseSessionCard();
      // 1 reserved + 1 durable = 2 → at the cap, reject.
      expect(await rl.tryReserveSessionCard(get)).toBe(false);
      // Free the other slot AND simulate a storage writeback (durable=0).
      rl.releaseSessionCard();
      durable = 0;
      // 0 reserved + 0 durable = 0 → under the cap, reserve.
      expect(await rl.tryReserveSessionCard(get)).toBe(true);
    });
  });

  describe("acquireCardStart() — max_cards_per_proxy rotation overflow guard", () => {
    it("throws after MAX_PROXY_ROTATION_ATTEMPTS failed rotations", async () => {
      // Rotator whose cardsOnIp never decreases — simulates the real
      // ProxyRotator hitting an API that keeps returning the same proxy.
      const rotator = {
        getCurrentState: (): ProxyRuntimeState => ({
          proxy: "http://rotator.test:8080",
          proxyChannel: "ch-stuck",
          ip: "1.2.3.4",
          cardsOnIp: 5
        }),
        rotate: vi.fn(async (_reason: string) => {
          // Does not lower cardsOnIp.
        }),
        tick: vi.fn(async () => {})
      } as unknown as ProxyRotator;

      const rl = new RateLimiter([0, 0], { maxCardsPerProxy: 3 }, rotator);
      await expect(rl.acquireCardStart()).rejects.toThrow(/rotation attempts did not lower/);
      expect(rotator.rotate).toHaveBeenCalledTimes(MAX_PROXY_ROTATION_ATTEMPTS);
    });

    it("does not throw when rotation eventually produces an under-cap proxy", async () => {
      let cardsOnIp = 5;
      let calls = 0;
      const rotator = {
        getCurrentState: (): ProxyRuntimeState => ({
          proxy: "http://rotator.test:8080",
          proxyChannel: "ch-recover",
          ip: "1.2.3.4",
          cardsOnIp
        }),
        rotate: vi.fn(async (_reason: string) => {
          calls += 1;
          if (calls >= 2) cardsOnIp = 0;
        }),
        tick: vi.fn(async () => {})
      } as unknown as ProxyRotator;

      const rl = new RateLimiter([0, 0], { maxCardsPerProxy: 3 }, rotator);
      await rl.acquireCardStart();
      expect(rotator.rotate).toHaveBeenCalledTimes(2);
    });

    it("rotation overflow does not consume a per-minute slot", async () => {
      // If the per-proxy rotation throws, the per-minute window must not
      // be poisoned by a reserved-but-unused slot. The reservation is
      // pushed only after the rotation block returns cleanly.
      const rotator = {
        getCurrentState: (): ProxyRuntimeState => ({
          proxy: "http://rotator.test:8080",
          proxyChannel: "ch-stuck",
          ip: "1.2.3.4",
          cardsOnIp: 5
        }),
        rotate: vi.fn(async (_reason: string) => {
          // never lowers cardsOnIp → overflow
        }),
        tick: vi.fn(async () => {})
      } as unknown as ProxyRotator;

      const rl = new RateLimiter([0, 0], { maxCardsPerMinute: 2, maxCardsPerProxy: 3 }, rotator);
      await expect(rl.acquireCardStart()).rejects.toThrow(/rotation attempts did not lower/);

      const timestamps = (rl as unknown as { cardStartTimestamps: number[] }).cardStartTimestamps;
      // No slot reserved because the rotation block threw before the push.
      expect(timestamps).toHaveLength(0);
    });
  });
});
