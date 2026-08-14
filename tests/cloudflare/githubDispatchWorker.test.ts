import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchScheduled,
  type DispatchDependencies,
} from "../../infra/cloudflare-github-dispatch/src/index.js";

const TOKEN = "test-token-do-not-use";
const SCHEDULED_TIME = Date.parse("2026-07-26T03:40:00Z");

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

describe("Cloudflare GitHub workflow dispatcher", () => {
  it.each([
    ["40 3 * * *", "gz-daily-pk.yml", undefined],
    ["10 4 * * *", "f3-daily.yml", undefined],
    ["0 5 * * *", "gz-daily-main.yml", undefined],
    ["30 6 * * *", "gz-watchdog.yml", undefined],
    ["0 8 * * *", "gz-daily-pk.yml", undefined],
    ["30 9 * * *", "gz-daily-main.yml", undefined],
    ["15 10 * * *", "gz-watchdog.yml", { window: "afternoon" }],
  ])("maps %s to %s and sends one authenticated dispatch", async (cron, workflow, inputs) => {
    const deps = dependencies(
      Response.json({
        workflow_run_id: 30190963247,
        run_url:
          "https://api.github.com/repos/timuroviceldar19-source/scrape2lead/actions/runs/30190963247",
        html_url:
          "https://github.com/timuroviceldar19-source/scrape2lead/actions/runs/30190963247",
      }),
    );

    await dispatchScheduled(
      { cron, scheduledTime: SCHEDULED_TIME },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith(
      `https://api.github.com/repos/timuroviceldar19-source/scrape2lead/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "scrape2lead-cloudflare-dispatch/1.0",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
      },
    );
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
      { cron: "40 3 * * *", scheduledTime: SCHEDULED_TIME },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: "40 3 * * *",
      workflow: "gz-daily-pk.yml",
      scheduledTime: "2026-07-26T03:40:00.000Z",
      status: 200,
      workflowRunId: 42,
      runUrl: "https://api.github.com/repos/example/actions/runs/42",
      htmlUrl: "https://github.com/example/actions/runs/42",
    });
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain(TOKEN);
  });

  it("accepts a legacy 204 response with no response body", async () => {
    const deps = dependencies(new Response(null, { status: 204 }));

    await expect(
      dispatchScheduled(
        { cron: "0 5 * * *", scheduledTime: SCHEDULED_TIME },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: "0 5 * * *",
      workflow: "gz-daily-main.yml",
      scheduledTime: "2026-07-26T03:40:00.000Z",
      status: 204,
    });
  });

  it("accepts a 2xx response whose body is not JSON", async () => {
    const deps = dependencies(new Response("accepted", { status: 202 }));

    await dispatchScheduled(
      { cron: "30 6 * * *", scheduledTime: SCHEDULED_TIME },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: "30 6 * * *",
      workflow: "gz-watchdog.yml",
      scheduledTime: "2026-07-26T03:40:00.000Z",
      status: 202,
    });
  });

  it("rejects a missing secret before contacting GitHub", async () => {
    const deps = dependencies(new Response(null, { status: 204 }));

    await expect(
      dispatchScheduled(
        { cron: "30 6 * * *", scheduledTime: SCHEDULED_TIME },
        { GITHUB_ACTIONS_TOKEN: "" },
        deps,
      ),
    ).rejects.toThrow("GITHUB_ACTIONS_TOKEN is not configured");

    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])(
    "does not retry permanent GitHub HTTP %s responses and redacts the token",
    async (status) => {
      const deps = dependencies(
        new Response(`request rejected for ${TOKEN}`, { status }),
      );

      const error = await dispatchScheduled(
        { cron: "30 6 * * *", scheduledTime: SCHEDULED_TIME },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
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
      { cron: "0 8 * * *", scheduledTime: SCHEDULED_TIME },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(deps.sleep).toHaveBeenNthCalledWith(2, 20_000);
    expect(deps.log).toHaveBeenNthCalledWith(1, {
      event: "github_workflow_dispatch_retry",
      cron: "0 8 * * *",
      workflow: "gz-daily-pk.yml",
      status: 503,
      attempt: 1,
      nextDelayMs: 5_000,
    });
    expect(deps.log).toHaveBeenNthCalledWith(2, {
      event: "github_workflow_dispatch_retry",
      cron: "0 8 * * *",
      workflow: "gz-daily-pk.yml",
      status: 502,
      attempt: 2,
      nextDelayMs: 20_000,
    });
    expect(deps.log).toHaveBeenLastCalledWith({
      event: "github_workflow_dispatch",
      cron: "0 8 * * *",
      workflow: "gz-daily-pk.yml",
      scheduledTime: "2026-07-26T03:40:00.000Z",
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
        { cron: "0 8 * * *", scheduledTime: SCHEDULED_TIME },
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

  it("rejects an unknown cron without contacting GitHub", async () => {
    const deps = dependencies(new Response(null, { status: 204 }));

    await expect(
      dispatchScheduled(
        { cron: "1 2 3 4 5", scheduledTime: SCHEDULED_TIME },
        { GITHUB_ACTIONS_TOKEN: TOKEN },
        deps,
      ),
    ).rejects.toThrow("Unknown cron trigger: 1 2 3 4 5");

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain(TOKEN);
  });
});

describe("Cloudflare cron wiring", () => {
  const wranglerCrons: string[] = JSON.parse(
    fs.readFileSync("infra/cloudflare-github-dispatch/wrangler.jsonc", "utf8")
      .replace(/^\s*\/\/.*$/gm, ""),
  ).triggers.crons;

  it("keeps wrangler.jsonc and WORKFLOW_BY_CRON in sync in both directions", async () => {
    // workflowForCron бросает на неизвестном кроне, поэтому расхождение этих двух
    // рукописных списков падает только в рантайме Worker.
    for (const cron of wranglerCrons) {
      const deps = dependencies(new Response(null, { status: 204 }));
      await expect(
        dispatchScheduled({ cron, scheduledTime: SCHEDULED_TIME }, { GITHUB_ACTIONS_TOKEN: TOKEN }, deps),
      ).resolves.toBeUndefined();
    }

    const dispatched = new Set<string>();
    for (const cron of wranglerCrons) {
      const deps = dependencies(new Response(null, { status: 204 }));
      await dispatchScheduled({ cron, scheduledTime: SCHEDULED_TIME }, { GITHUB_ACTIONS_TOKEN: TOKEN }, deps);
      dispatched.add(String(deps.fetch.mock.calls[0]?.[0]).split("/workflows/")[1]?.split("/")[0] ?? "");
    }
    expect([...dispatched].sort()).toEqual(
      ["f3-daily.yml", "gz-daily-main.yml", "gz-daily-pk.yml", "gz-watchdog.yml"],
    );
  });

  it("runs an afternoon watchdog after both repeat collection slots", () => {
    expect(wranglerCrons).toContain("15 10 * * *");

    const watchdog = fs.readFileSync(".github/workflows/gz-watchdog.yml", "utf8");
    expect(watchdog).toContain('cron: "15 10 * * *"');
    expect(watchdog).toContain("window:");
    expect(watchdog).toContain('default: "morning"');
    expect(watchdog).toContain('pk_since="${day}T08:00:00Z"');
    expect(watchdog).toContain('main_since="${day}T09:30:00Z"');
  });

  it("dispatches only the primary F3 slot, leaving the backstop to GitHub's own schedule", () => {
    // Диспетч приходит как workflow_dispatch, а guard пропускает такие запуски
    // безусловно: backstop-слот в Worker обесценил бы проверку «сегодня уже собрано».
    expect(wranglerCrons).toContain("10 4 * * *");
    expect(wranglerCrons).not.toContain("10 5 * * *");

    const daily = fs.readFileSync(".github/workflows/f3-daily.yml", "utf8");
    expect(daily).toContain('cron: "10 4 * * *"');
    expect(daily).toContain('cron: "10 5 * * *"');
  });
});
