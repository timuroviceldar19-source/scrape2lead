export async function withRetry<T>(
  action: () => Promise<T>,
  options: { maxRetries: number; baseDelayMs?: number; shouldRetry?: (error: unknown) => boolean }
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= options.maxRetries) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (options.shouldRetry && !options.shouldRetry(error)) break;
      if (attempt === options.maxRetries) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      attempt += 1;
    }
  }
  throw lastError;
}
