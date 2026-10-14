import { describe, expect, it } from "vitest";
import { DailyUsageLimiter } from "../../src/assistant/usageLimits.js";

// 2026-10-13 12:00 в Алматы (UTC+5)
const NOON = Date.parse("2026-10-13T07:00:00Z");
const HOUR = 3_600_000;

describe("DailyUsageLimiter", () => {
  it("allows a user up to the personal limit and then refuses", () => {
    const limiter = new DailyUsageLimiter({ perUserPerDay: 2, totalPerDay: 100 });

    expect(limiter.tryConsume(1, NOON)).toEqual({ allowed: true, userRemaining: 1 });
    expect(limiter.tryConsume(1, NOON)).toEqual({ allowed: true, userRemaining: 0 });
    expect(limiter.tryConsume(1, NOON)).toEqual({ allowed: false, reason: "user" });
  });

  it("counts users separately", () => {
    const limiter = new DailyUsageLimiter({ perUserPerDay: 1, totalPerDay: 100 });

    limiter.tryConsume(1, NOON);

    expect(limiter.tryConsume(2, NOON).allowed).toBe(true);
  });

  it("stops everyone when the total cap is reached and does not charge the user for a refusal", () => {
    const limiter = new DailyUsageLimiter({ perUserPerDay: 10, totalPerDay: 2 });

    limiter.tryConsume(1, NOON);
    limiter.tryConsume(2, NOON);

    expect(limiter.tryConsume(3, NOON)).toEqual({ allowed: false, reason: "total" });
    expect(limiter.usage(3, NOON)).toEqual({ user: 0, total: 2 });
  });

  it("starts a new day at midnight Almaty time, not UTC", () => {
    const limiter = new DailyUsageLimiter({ perUserPerDay: 1, totalPerDay: 100 });
    const beforeMidnight = Date.parse("2026-10-13T18:30:00Z"); // 23:30 Almaty
    const afterMidnight = Date.parse("2026-10-13T19:30:00Z"); // 00:30 Almaty, next day

    limiter.tryConsume(1, beforeMidnight);

    expect(limiter.tryConsume(1, beforeMidnight + HOUR / 4).allowed).toBe(false); // 23:45, тот же день
    expect(limiter.tryConsume(1, afterMidnight).allowed).toBe(true);
  });
});
