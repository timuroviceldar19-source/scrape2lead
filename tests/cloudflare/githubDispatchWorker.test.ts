import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchScheduled,
  SCHEDULED_CRONS,
  type DispatchDependencies,
} from "../../infra/cloudflare-github-dispatch/src/index.js";

const TOKEN = "test-token-do-not-use";
const CRON_MORNING = "40 3 * * *";
const CRON_HOURLY = "30 4-11 * * *";
const CRON_AFTERNOON_WATCHDOG = "15 10 * * *";

function at(utcTime: string): number {
  return Date.parse(`2026-07-26T${utcTime}:00Z`);
}

function dependencies(...responses: Response[]) {
  const queue = [...responses];
  const fetch = vi.fn<DispatchDependencies["fetch"]>().mockImplementation(async () => {
    const response = queue.shift();
    if (!response) {
      throw new Error("test fetch response queue exhausted");
    }
    return response;
  });
  const log = vi.fn<DispatchDependencies["log"]>();
  const sleep = vi.fn<NonNullable<DispatchDependencies["sleep"]>>().mockResolvedValue();
  return { fetch, log, sleep };
}

function accepted(count: number): Response[] {
  return Array.from({ length: count }, () => new Response(null, { status: 204 }));
}

interface SentDispatch {
  workflow: string;
  body: { ref: string; inputs?: Record<string, string> };
}

function sent(deps: ReturnType<typeof dependencies>): SentDispatch[] {
  return deps.fetch.mock.calls.map(([url, init]) => ({
    workflow: String(url).split("/workflows/")[1]?.split("/")[0] ?? "",
    body: JSON.parse(String((init as RequestInit).body)),
  }));
}

const PK_MORNING: SentDispatch = {
  workflow: "gz-daily-pk.yml",
  body: { ref: "main", inputs: { deal_outcomes: "true" } },
};
const PK_HOURLY: SentDispatch = {
  workflow: "gz-daily-pk.yml",
  body: { ref: "main", inputs: { deal_outcomes: "false" } },
};
const MAIN: SentDispatch = { workflow: "gz-daily-main.yml", body: { ref: "main" } };
const WATCHDOG_MORNING: SentDispatch = { workflow: "gz-watchdog.yml", body: { ref: "main" } };
const WATCHDOG_AFTERNOON: SentDispatch = {
  workflow: "gz-watchdog.yml",
  body: { ref: "main", inputs: { window: "afternoon" } },
};

describe("Cloudflare GitHub workflow dispatcher", () => {
  it.each([
    [CRON_MORNING, "03:40", [PK_MORNING, MAIN]],
    [CRON_HOURLY, "04:30", [PK_HOURLY, MAIN]],
    [CRON_HOURLY, "05:30", [PK_HOURLY, MAIN]],
    [CRON_HOURLY, "06:30", [PK_HOURLY, MAIN, WATCHDOG_MORNING]],
    [CRON_HOURLY, "07:30", [PK_HOURLY, MAIN]],
    [CRON_HOURLY, "08:30", [PK_HOURLY, MAIN]],
    [CRON_HOURLY, "09:30", [PK_HOURLY, MAIN]],
    [CRON_HOURLY, "10:30", [PK_HOURLY, MAIN]],
    [CRON_HOURLY, "11:30", [PK_HOURLY, MAIN]],
    [CRON_AFTERNOON_WATCHDOG, "10:15", [WATCHDOG_AFTERNOON]],
  ])("maps %s at %s UTC to the expected authenticated dispatches", async (cron, utcTime, expected) => {
    const deps = dependencies(...accepted(expected.length));

    await dispatchScheduled(
      { cron, scheduledTime: at(utcTime) },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(sent(deps)).toEqual(expected);
    for (const [url, init] of deps.fetch.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/api\.github\.com\/repos\/timuroviceldar19-source\/scrape2lead\/actions\/workflows\/[\w.-]+\/dispatches$/,
      );
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "scrape2lead-cloudflare-dispatch/1.0",
          "X-GitHub-Api-Version": "2026-03-10",
        },
      });
    }
  });

  it("starts PK and main in the same invocation without waiting for one another", async () => {
    let releasePk: () => void = () => undefined;
    const pkGate = new Promise<void>((resolve) => {
      releasePk = resolve;
    });
    const calls: string[] = [];
    const fetch = vi.fn<DispatchDependencies["fetch"]>().mockImplementation(async (url) => {
      const workflow = String(url).split("/workflows/")[1]?.split("/")[0] ?? "";
      calls.push(workflow);
      if (workflow === "gz-daily-pk.yml") {
        await pkGate;
      }
      return new Response(null, { status: 204 });
    });

    const pending = dispatchScheduled(
      { cron: CRON_MORNING, scheduledTime: at("03:40") },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      { fetch, log: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined) },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(["gz-daily-pk.yml", "gz-daily-main.yml"]);
    releasePk();
    await pending;
  });

  it("logs the run identifiers returned by a 200 response without logging the token", async () => {
    const deps = dependencies(
      Response.json({
        workflow_run_id: 42,
        run_url: "https://api.github.com/repos/example/actions/runs/42",
        html_url: "https://github.com/example/actions/runs/42",
      }),
    );

    await dispatchScheduled(
      { cron: CRON_AFTERNOON_WATCHDOG, scheduledTime: at("10:15") },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: CRON_AFTERNOON_WATCHDOG,
      workflow: "gz-watchdog.yml",
      scheduledTime: "2026-07-26T10:15:00.000Z",
      status: 200,
      workflowRunId: 42,
      runUrl: "https://api.github.com/repos/example/actions/runs/42",
      htmlUrl: "https://github.com/example/actions/runs/42",
    });
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain(TOKEN);
  });

  it("logs one entry per dispatched workflow", async () => {
    const deps = dependencies(...accepted(2));

    await dispatchScheduled(
      { cron: CRON_HOURLY, scheduledTime: at("04:30") },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.log).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: CRON_HOURLY,
      workflow: "gz-daily-pk.yml",
      scheduledTime: "2026-07-26T04:30:00.000Z",
      status: 204,
    });
    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: CRON_HOURLY,
      workflow: "gz-daily-main.yml",
      scheduledTime: "2026-07-26T04:30:00.000Z",
      status: 204,
    });
  });

  it("accepts a 2xx response whose body is not JSON", async () => {
    const deps = dependencies(new Response("accepted", { status: 202 }));

    await dispatchScheduled(
      { cron: CRON_AFTERNOON_WATCHDOG, scheduledTime: at("10:15") },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: CRON_AFTERNOON_WATCHDOG,
      workflow: "gz-watchdog.yml",
      scheduledTime: "2026-07-26T10:15:00.000Z",
      status: 202,
    });
  });

  it("rejects a missing secret before contacting GitHub", async () => {
    const deps = dependencies(...accepted(2));

    await expect(
      dispatchScheduled(
        { cron: CRON_MORNING, scheduledTime: at("03:40") },
        { GITHUB_ACTIONS_TOKEN: "" },
        deps,
      ),
    ).rejects.toThrow("GITHUB_ACTIONS_TOKEN is not configured");

    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry permanent GitHub HTTP %s responses and redacts the token",
    async (status) => {
      const deps = dependencies(new Response(`request rejected for ${TOKEN}`, { status }));

      const error = await dispatchScheduled(
        { cron: CRON_AFTERNOON_WATCHDOG, scheduledTime: at("10:15") },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).toContain("gz-watchdog.yml");
      expect((error as Error).message).toContain("[REDACTED]");
      expect((error as Error).message).not.toContain(TOKEN);
      expect(deps.fetch).toHaveBeenCalledTimes(1);
      expect(deps.sleep).not.toHaveBeenCalled();
      expect(JSON.stringify(deps.log.mock.calls)).not.toContain(TOKEN);
    },
  );

  it("retries transient GitHub responses with bounded backoff and then succeeds", async () => {
    const deps = dependencies(
      new Response("temporary failure", { status: 503 }),
      new Response("still unavailable", { status: 502 }),
      new Response(null, { status: 204 }),
    );

    await dispatchScheduled(
      { cron: CRON_AFTERNOON_WATCHDOG, scheduledTime: at("10:15") },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(deps.sleep).toHaveBeenNthCalledWith(2, 20_000);
    expect(deps.log).toHaveBeenNthCalledWith(1, {
      event: "github_workflow_dispatch_retry",
      cron: CRON_AFTERNOON_WATCHDOG,
      workflow: "gz-watchdog.yml",
      status: 503,
      attempt: 1,
      nextDelayMs: 5_000,
    });
    expect(deps.log).toHaveBeenNthCalledWith(2, {
      event: "github_workflow_dispatch_retry",
      cron: CRON_AFTERNOON_WATCHDOG,
      workflow: "gz-watchdog.yml",
      status: 502,
      attempt: 2,
      nextDelayMs: 20_000,
    });
    expect(deps.log).toHaveBeenLastCalledWith({
      event: "github_workflow_dispatch",
      cron: CRON_AFTERNOON_WATCHDOG,
      workflow: "gz-watchdog.yml",
      scheduledTime: "2026-07-26T10:15:00.000Z",
      status: 204,
    });
  });

  it.each([429, 500, 502, 503, 504])(
    "stops after three attempts on transient GitHub HTTP %s",
    async (status) => {
      const deps = dependencies(
        new Response(`request rejected for ${TOKEN}`, { status }),
        new Response(`request rejected for ${TOKEN}`, { status }),
        new Response(`request rejected for ${TOKEN}`, { status }),
      );

      const error = await dispatchScheduled(
        { cron: CRON_AFTERNOON_WATCHDOG, scheduledTime: at("10:15") },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).toContain("[REDACTED]");
      expect((error as Error).message).not.toContain(TOKEN);
      expect(deps.fetch).toHaveBeenCalledTimes(3);
      expect(deps.sleep).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(deps.log.mock.calls)).not.toContain(TOKEN);
    },
  );

  it("still dispatches main when the PK dispatch is rejected, then reports the failure", async () => {
    const fetch = vi.fn<DispatchDependencies["fetch"]>().mockImplementation(async (url) => {
      const workflow = String(url).split("/workflows/")[1]?.split("/")[0];
      return workflow === "gz-daily-pk.yml"
        ? new Response(`bad credentials ${TOKEN}`, { status: 401 })
        : new Response(null, { status: 204 });
    });
    const log = vi.fn<DispatchDependencies["log"]>();

    const error = await dispatchScheduled(
      { cron: CRON_HOURLY, scheduledTime: at("05:30") },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      { fetch, log, sleep: vi.fn().mockResolvedValue(undefined) },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("gz-daily-pk.yml");
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).not.toContain(TOKEN);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "github_workflow_dispatch", workflow: "gz-daily-main.yml" }),
    );
  });

  it("rejects an unknown cron without contacting GitHub", async () => {
    const deps = dependencies(...accepted(2));

    await expect(
      dispatchScheduled(
        { cron: "1 2 3 4 5", scheduledTime: at("03:40") },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ),
    ).rejects.toThrow("Unknown cron trigger: 1 2 3 4 5");

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain(TOKEN);
  });

  it.each(["03:30", "12:30", "23:30"])(
    "rejects an unexpected time %s UTC emitted for the hourly cron",
    async (utcTime) => {
      const deps = dependencies(...accepted(2));

      await expect(
        dispatchScheduled(
          { cron: CRON_HOURLY, scheduledTime: at(utcTime) },
          { GITHUB_ACTIONS_TOKEN: TOKEN },
          deps,
        ),
      ).rejects.toThrow("Unexpected scheduled time");

      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("Cloudflare cron wiring", () => {
  const wranglerCrons: string[] = JSON.parse(
    fs.readFileSync("infra/cloudflare-github-dispatch/wrangler.jsonc", "utf8")
      .replace(/^\s*\/\/.*$/gm, ""),
  ).triggers.crons;

  it("keeps wrangler.jsonc and SCHEDULED_CRONS in sync in both directions", () => {
    expect([...wranglerCrons].sort()).toEqual([...SCHEDULED_CRONS].sort());
  });

  it("stays within the Cloudflare Free limit of five cron triggers", () => {
    expect(wranglerCrons.length).toBeLessThanOrEqual(5);
  });

  it("dispatches PK and main together in every slot from 08:40 to 16:30 Almaty", async () => {
    const slots = [
      [CRON_MORNING, "03:40"],
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((hour) => [CRON_HOURLY, `${String(hour).padStart(2, "0")}:30`]),
    ] as const;
    // 08:40, 09:30 ... 16:30 по Алматы (UTC+5).
    expect(slots).toHaveLength(9);

    for (const [cron, utcTime] of slots) {
      const deps = dependencies(...accepted(3));
      await dispatchScheduled(
        { cron, scheduledTime: at(utcTime) },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      );
      const workflows = sent(deps).map((dispatch) => dispatch.workflow);
      expect(workflows).toContain("gz-daily-pk.yml");
      expect(workflows).toContain("gz-daily-main.yml");
    }
  });

  it("enables the deal outcome check only for the morning slot", async () => {
    const outcomes: Array<string | undefined> = [];
    for (const [cron, utcTime] of [
      [CRON_MORNING, "03:40"],
      [CRON_HOURLY, "04:30"],
      [CRON_HOURLY, "08:30"],
      [CRON_HOURLY, "11:30"],
    ] as const) {
      const deps = dependencies(...accepted(3));
      await dispatchScheduled(
        { cron, scheduledTime: at(utcTime) },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      );
      outcomes.push(sent(deps).find((d) => d.workflow === "gz-daily-pk.yml")?.body.inputs?.deal_outcomes);
    }
    expect(outcomes).toEqual(["true", "false", "false", "false"]);
  });

  it("schedules the main GitHub backstop at 09:20 with a 10:20 fallback", () => {
    const main = fs.readFileSync(".github/workflows/gz-daily-main.yml", "utf8");

    expect(main).toContain('cron: "20 4 * * *"');
    expect(main).toContain('cron: "20 5 * * *"');
  });

  it("runs an afternoon watchdog after the 13:00 and 13:30 collection slots", () => {
    expect(wranglerCrons).toContain(CRON_AFTERNOON_WATCHDOG);

    const watchdog = fs.readFileSync(".github/workflows/gz-watchdog.yml", "utf8");
    expect(watchdog).toContain('cron: "15 10 * * *"');
    expect(watchdog).toContain("window:");
    expect(watchdog).toContain('default: "morning"');
    expect(watchdog).toContain('pk_since="${day}T08:00:00Z"');
    expect(watchdog).toContain('main_since="${day}T08:30:00Z"');
  });

  it("does not dispatch the removed F3 workflow", async () => {
    expect(wranglerCrons).not.toContain("10 4 * * *");
    expect(wranglerCrons).not.toContain("10 5 * * *");
    expect(fs.existsSync(".github/workflows/f3-daily.yml")).toBe(false);
    expect(fs.existsSync(".github/workflows/f3-automation.yml")).toBe(false);

    const deps = dependencies(new Response(null, { status: 204 }));
    await expect(
      dispatchScheduled(
        { cron: "10 4 * * *", scheduledTime: at("04:10") },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ),
    ).rejects.toThrow("Unknown cron trigger: 10 4 * * *");
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
