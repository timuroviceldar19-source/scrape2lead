export class Logger {
  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: string, message: string, meta?: unknown): void {
    const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
    process.stdout.write(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}\n`);
  }
}

export const logger = new Logger();
