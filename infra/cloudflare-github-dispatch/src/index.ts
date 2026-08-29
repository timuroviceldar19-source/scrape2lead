const GITHUB_OWNER = "timuroviceldar19-source";
const GITHUB_REPOSITORY = "scrape2lead";
const GITHUB_REF = "main";
const GITHUB_API_VERSION = "2026-03-10";
const ERROR_BODY_LIMIT = 1_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5_000, 20_000] as const;

// Казахстан живёт в UTC+5 без перехода на летнее время, поэтому смещение постоянное.
//
// Утренняя пара 08:40/10:00 собирает основной объём. Дневная пара 13:00/14:30 —
// не backstop, а осознанный повторный сбор: планы публикуются в течение дня, и
// утренний прогон их не видит. Guard пропускает повтор только для
// event=schedule, а Worker шлёт workflow_dispatch, поэтому дневные слоты
// отрабатывают безусловно. Повтор безопасен — дедупликация идёт в Bitrix по
// UF_CRM_PLAN_ID, повторно встреченный план не создаёт вторую сделку.
//
// Сторож стоит в 11:30 — после утренней пары и до дневной, чтобы пропуск
// утреннего сбора был виден до того, как дневной прогон его замаскирует.
//
// F3 B2B идёт один раз, в 09:10, между PK и main. Здесь стоит ТОЛЬКО основной слот:
// backstop-триггер 05:10 UTC живёт в самом f3-daily.yml как schedule. Диспетч из
// Worker приходит как event=workflow_dispatch, а guard пропускает такие запуски
// безусловно — добавив сюда backstop, мы бы обесценили его проверку.
const WORKFLOW_BY_CRON = {
  "40 3 * * *": "gz-daily-pk.yml", // 08:40 Алматы
  "10 4 * * *": "f3-daily.yml", // 09:10 Алматы
  // Cloudflare Free allows five cron triggers per account. These two expressions
  // each cover two exact slots; scheduledTime selects the intended workflow.
  "0 5,8 * * *": { 5: "gz-daily-main.yml", 8: "gz-daily-pk.yml" }, // 10:00/13:00 Алматы
  "30 6,9 * * *": { 6: "gz-watchdog.yml", 9: "gz-daily-main.yml" }, // 11:30/14:30 Алматы
  "15 10 * * *": "gz-watchdog.yml", // 15:15 Алматы
} as const;

const INPUTS_BY_CRON: Partial<Record<keyof typeof WORKFLOW_BY_CRON, Record<string, string>>> = {
  "15 10 * * *": { window: "afternoon" },
};

export interface DispatchEnvironment {
  GITHUB_ACTIONS_TOKEN: string;
}

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

export interface DispatchDependencies {
  fetch: typeof fetch;
  log: (entry: Record<string, unknown>) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface GitHubDispatchResponse {
  workflow_run_id?: number;
  run_url?: string;
  html_url?: string;
}

/* v8 ignore next 4 -- exercised by Wrangler's runtime adapter, not Node unit tests */
const DEFAULT_DEPENDENCIES: DispatchDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  log: (entry) => console.log(JSON.stringify(entry)),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function workflowForSchedule(cron: string, scheduledTime: number): string {
  const target = WORKFLOW_BY_CRON[cron as keyof typeof WORKFLOW_BY_CRON];
  if (!target) {
    throw new Error(`Unknown cron trigger: ${cron}`);
  }
  if (typeof target === "string") {
    return target;
  }

  const scheduledHour = new Date(scheduledTime).getUTCHours();
  const workflow = target[scheduledHour as keyof typeof target];
  if (!workflow) {
    throw new Error(`Unexpected scheduled time for cron ${cron}: ${scheduledTime}`);
  }
  return workflow;
}

function redact(value: string, secret: string): string {
  return value.replaceAll(secret, "[REDACTED]");
}

async function responseData(response: Response): Promise<GitHubDispatchResponse> {
  if (response.status === 204) {
    return {};
  }

  const body = await response.text();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as GitHubDispatchResponse;
  } catch {
    return {};
  }
}

export async function dispatchScheduled(
  controller: ScheduledControllerLike,
  env: DispatchEnvironment,
  dependencies: DispatchDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const workflow = workflowForSchedule(controller.cron, controller.scheduledTime);
  const token = env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    throw new Error("GITHUB_ACTIONS_TOKEN is not configured");
  }

  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}` +
    `/actions/workflows/${workflow}/dispatches`;
  const inputs = INPUTS_BY_CRON[controller.cron as keyof typeof WORKFLOW_BY_CRON];
  const request = {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "scrape2lead-cloudflare-dispatch/1.0",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: JSON.stringify(inputs ? { ref: GITHUB_REF, inputs } : { ref: GITHUB_REF }),
  };

  let response: Response | undefined;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
    response = await dependencies.fetch(url, request);
    const retryDelay = RETRY_DELAYS_MS[attempt - 1];
    if (response.ok || !RETRYABLE_STATUSES.has(response.status) || retryDelay === undefined) {
      break;
    }

    dependencies.log({
      event: "github_workflow_dispatch_retry",
      cron: controller.cron,
      workflow,
      status: response.status,
      attempt,
      nextDelayMs: retryDelay,
    });
    await (dependencies.sleep ?? DEFAULT_DEPENDENCIES.sleep)?.(retryDelay);
  }

  if (!response) {
    throw new Error("GitHub workflow dispatch did not produce a response");
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, ERROR_BODY_LIMIT);
    const safeBody = redact(body, token);
    const suffix = safeBody ? `: ${safeBody}` : "";
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}${suffix}`);
  }

  const data = await responseData(response);
  const entry: Record<string, unknown> = {
    event: "github_workflow_dispatch",
    cron: controller.cron,
    workflow,
    scheduledTime: new Date(controller.scheduledTime).toISOString(),
    status: response.status,
  };

  if (data.workflow_run_id !== undefined) {
    entry.workflowRunId = data.workflow_run_id;
  }
  if (data.run_url !== undefined) {
    entry.runUrl = data.run_url;
  }
  if (data.html_url !== undefined) {
    entry.htmlUrl = data.html_url;
  }

  dependencies.log(entry);
}

/* v8 ignore next 8 -- Wrangler dry-run validates the scheduled runtime adapter */
export default {
  async scheduled(
    controller: ScheduledControllerLike,
    env: DispatchEnvironment,
  ): Promise<void> {
    await dispatchScheduled(controller, env);
  },
};
