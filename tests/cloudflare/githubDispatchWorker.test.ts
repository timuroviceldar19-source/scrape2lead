import { describe, expect, it, vi } from "vitest";

import {
  dispatchScheduled,
  type DispatchDependencies,
} from "../../infra/cloudflare-github-dispatch/src/index.js";

const TOKEN = "test-token-do-not-use";
const SCHEDULED_TIME = Date.parse("2026-07-26T03:40:00Z");

function dependencies(response: Response) {
  const fetch = vi.fn<DispatchDependencies["fetch"]>().mockResolvedValue(response);
  const log = vi.fn<DispatchDependencies["log"]>();
  return { fetch, log };
}

describe("Cloudflare GitHub workflow dispatcher", () => {
  it.each([
    ["40 3 * * *", "gz-daily-pk.yml"],
    ["0 5 * * *", "gz-daily-main.yml"],
    ["0 8 * * *", "gz-watchdog.yml"],
  ])("maps %s to %s and sends one authenticated dispatch", async (cron, workflow) => {
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
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify({ ref: "main" }),
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
      { cron: "0 8 * * *", scheduledTime: SCHEDULED_TIME },
      { GITHUB_ACTIONS_TOKEN: TOKEN },
      deps,
    );

    expect(deps.log).toHaveBeenCalledWith({
      event: "github_workflow_dispatch",
      cron: "0 8 * * *",
      workflow: "gz-watchdog.yml",
      scheduledTime: "2026-07-26T03:40:00.000Z",
      status: 202,
    });
  });

  it("rejects a missing secret before contacting GitHub", async () => {
    const deps = dependencies(new Response(null, { status: 204 }));

    await expect(
      dispatchScheduled(
        { cron: "0 8 * * *", scheduledTime: SCHEDULED_TIME },
        { GITHUB_ACTIONS_TOKEN: "" },
        deps,
      ),
    ).rejects.toThrow("GITHUB_ACTIONS_TOKEN is not configured");

    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500, 503])(
    "throws once on GitHub HTTP %s and redacts the token",
    async (status) => {
      const deps = dependencies(
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
      expect(deps.fetch).toHaveBeenCalledTimes(1);
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
