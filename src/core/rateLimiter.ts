export class RateLimiter {
  constructor(private readonly delayRangeMs: [number, number]) {}

  async wait(): Promise<void> {
    const [min, max] = this.delayRangeMs;
    const delay = Math.floor(min + Math.random() * Math.max(1, max - min));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
