import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LockContents {
  pid: number;
  host: string;
  startedAt: string;
  command: string;
}

export interface LockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export type ProcessAliveCheck = (pid: number, host: string) => boolean;

export const defaultIsProcessAlive: ProcessAliveCheck = (pid, host) => {
  if (host !== os.hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class LockBusyError extends Error {
  readonly code = "LOCK_BUSY";
  constructor(public readonly contents: LockContents, public readonly lockPath: string) {
    super(
      `autopilot: lock busy: pid=${contents.pid} host=${contents.host} `
      + `startedAt=${contents.startedAt} command=${contents.command}`
    );
  }
}

export interface AcquireOptions {
  lockPath?: string;
  isProcessAlive?: ProcessAliveCheck;
  command?: string;
  now?: () => Date;
}

export async function acquireAutopilotLock(options: AcquireOptions = {}): Promise<LockHandle> {
  const lockPath = options.lockPath ?? path.join(process.cwd(), "data", "autopilot.lock");
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? (() => new Date());
  const command = options.command ?? "kz-autopilot";

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const tryWrite = (): boolean => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, "wx");
      const contents: LockContents = {
        pid: process.pid,
        host: os.hostname(),
        startedAt: now().toISOString(),
        command
      };
      fs.writeSync(fd, JSON.stringify(contents, null, 2));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* fd may not be open */ }
      }
    }
  };

  if (tryWrite()) {
    return makeHandle(lockPath);
  }

  const existing = readLockContents(lockPath);
  if (existing && !isProcessAlive(existing.pid, existing.host)) {
    try { fs.unlinkSync(lockPath); } catch { /* already removed by another process */ }
    if (tryWrite()) {
      return makeHandle(lockPath);
    }
  }

  const finalContents: LockContents = existing ?? {
    pid: 0,
    host: "?",
    startedAt: "?",
    command: "?"
  };
  throw new LockBusyError(finalContents, lockPath);
}

function readLockContents(lockPath: string): LockContents | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockContents>;
    if (typeof parsed.pid !== "number" || typeof parsed.host !== "string") return null;
    return {
      pid: parsed.pid,
      host: parsed.host,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "?",
      command: typeof parsed.command === "string" ? parsed.command : "?"
    };
  } catch {
    return null;
  }
}

function makeHandle(lockPath: string): LockHandle {
  let released = false;
  return {
    path: lockPath,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }
  };
}
