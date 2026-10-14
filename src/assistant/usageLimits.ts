/**
 * Дневные лимиты запросов к ИИ: на сотрудника и общий потолок на всех.
 * Сутки считаются по времени Алматы (UTC+5), чтобы лимит обнулялся в полночь по-местному.
 * Счётчики живут в памяти процесса: после перезапуска бота они обнуляются.
 */

const ALMATY_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

export interface UsageLimits {
  perUserPerDay: number;
  totalPerDay: number;
}

export type ConsumeResult = { allowed: true; userRemaining: number } | { allowed: false; reason: "user" | "total" };

interface Counter {
  day: number;
  count: number;
}

export class DailyUsageLimiter {
  private readonly users = new Map<number, Counter>();
  private total: Counter = { day: -1, count: 0 };

  constructor(private readonly limits: UsageLimits) {}

  /** Списывает один запрос; отказ ничего не списывает. */
  tryConsume(userId: number, now: number): ConsumeResult {
    const day = dayOf(now);
    const total = this.currentTotal(day);
    if (total.count >= this.limits.totalPerDay) return { allowed: false, reason: "total" };

    const user = this.currentUser(userId, day);
    if (user.count >= this.limits.perUserPerDay) return { allowed: false, reason: "user" };

    user.count += 1;
    total.count += 1;
    return { allowed: true, userRemaining: this.limits.perUserPerDay - user.count };
  }

  usage(userId: number, now: number): { user: number; total: number } {
    const day = dayOf(now);
    return { user: this.currentUser(userId, day).count, total: this.currentTotal(day).count };
  }

  private currentUser(userId: number, day: number): Counter {
    let counter = this.users.get(userId);
    if (!counter || counter.day !== day) {
      counter = { day, count: 0 };
      this.users.set(userId, counter);
    }
    return counter;
  }

  private currentTotal(day: number): Counter {
    if (this.total.day !== day) this.total = { day, count: 0 };
    return this.total;
  }
}

function dayOf(now: number): number {
  return Math.floor((now + ALMATY_OFFSET_MS) / DAY_MS);
}
