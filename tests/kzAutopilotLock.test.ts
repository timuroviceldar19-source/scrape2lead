import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireAutopilotLock, LockBusyError } from "../src/kz/autopilotLock.js";

describe("acquireAutopilotLock", () => {
  let dir: string;
  let lockPath: string;
  const fixedNow = new Date("2026-06-17T08:00:00.000Z");
  const aliveTrue = () => true;
  const aliveFalse = () => false;
  const aliveOnlyCurrent = (pid: number) => pid === process.pid;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrape2lead-lock-"));
    lockPath = path.join(dir, "autopilot.lock");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("acquires and releases a fresh lock", async () => {
    const lock = await acquireAutopilotLock({ lockPath, now: () => fixedNow, command: "kz-autopilot" });
    expect(fs.existsSync(lockPath)).toBe(true);
    const contents = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    expect(contents.pid).toBe(process.pid);
    expect(contents.host).toBe(os.hostname());
    expect(contents.startedAt).toBe(fixedNow.toISOString());
    expect(contents.command).toBe("kz-autopilot");

    await lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);

    const second = await acquireAutopilotLock({ lockPath, now: () => fixedNow });
    const contents2 = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    expect(contents2.pid).toBe(process.pid);
    await second.release();
  });

  it("throws LockBusyError with holder info when another run holds the lock", async () => {
    const lock = await acquireAutopilotLock({ lockPath, now: () => fixedNow });
    try {
      await acquireAutopilotLock({ lockPath, now: () => fixedNow, isProcessAlive: aliveTrue });
      throw new Error("expected LockBusyError");
    } catch (err) {
      expect(err).toBeInstanceOf(LockBusyError);
      const busy = err as LockBusyError;
      expect(busy.contents.pid).toBe(process.pid);
      expect(busy.contents.host).toBe(os.hostname());
      expect(busy.contents.startedAt).toBe(fixedNow.toISOString());
      expect(busy.contents.command).toBe("kz-autopilot");
      expect(busy.lockPath).toBe(lockPath);
      expect(busy.message).toContain("lock busy");
    }

    const stillThere = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    expect(stillThere.pid).toBe(process.pid);

    await lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("removes a stale lock and re-acquires when process-alive check returns false", async () => {
    const deadPid = 999_999_999;
    fs.writeFileSync(
      lockPath,
      JSON.stringify(
        { pid: deadPid, host: os.hostname(), startedAt: "2026-01-01T00:00:00.000Z", command: "old-run" },
        null,
        2
      ),
      "utf8"
    );

    const lock = await acquireAutopilotLock({
      lockPath,
      now: () => fixedNow,
      isProcessAlive: aliveFalse
    });

    const contents = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    expect(contents.pid).toBe(process.pid);
    expect(contents.startedAt).toBe(fixedNow.toISOString());
    expect(contents.command).toBe("kz-autopilot");

    await lock.release();
  });

  it("preserves a live lock when process-alive check returns true", async () => {
    const first = await acquireAutopilotLock({ lockPath, now: () => fixedNow });

    await expect(
      acquireAutopilotLock({
        lockPath,
        now: () => fixedNow,
        isProcessAlive: aliveOnlyCurrent
      })
    ).rejects.toBeInstanceOf(LockBusyError);

    const contents = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    expect(contents.pid).toBe(process.pid);
    expect(contents.startedAt).toBe(fixedNow.toISOString());

    await first.release();
  });

  it("release is idempotent", async () => {
    const lock = await acquireAutopilotLock({ lockPath, now: () => fixedNow });
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
