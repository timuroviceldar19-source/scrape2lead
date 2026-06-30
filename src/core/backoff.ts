export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  jitter?: number;
}

export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 2000;
  const capMs = options.capMs ?? 60000;
  const jitter = options.jitter ?? 0.2;
  const safeAttempt = Math.max(1, attempt);
  const exp = Math.min(baseMs * 2 ** (safeAttempt - 1), capMs);
  const delta = exp * jitter;
  const noise = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(exp + noise));
}
