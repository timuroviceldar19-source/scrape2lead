const GITHUB_OWNER = "timuroviceldar19-source";
const GITHUB_REPOSITORY = "scrape2lead";
const GITHUB_REF = "main";
const GITHUB_API_VERSION = "2026-03-10";
const ERROR_BODY_LIMIT = 1_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5_000, 20_000] as const;

// Казахстан живёт в UTC+5 без перехода на летнее время, поэтому смещение постоянное.
//
// Сбор идёт почасово: PK (config/automation.pk.json) и main (config/automation.json)
// стартуют ОДНОВРЕМЕННО в 08:40, затем каждый час в :30 до 16:30 Алматы
// (03:40, 04:30 ... 11:30 UTC). Наборы планов у них не пересекаются, а concurrency-группы
// и кэш у каждого свои. Guard пропускает повтор только для event=schedule, а Worker
// шлёт workflow_dispatch, поэтому каждый слот отрабатывает безусловно. Повтор безопасен —
// дедупликация идёт в Bitrix по UF_CRM_PLAN_ID. Потеря одного диспетча перестаёт быть
// проблемой: следующий слот подхватит тот же объём через час.
//
// Проверка итогов сделок (deal-outcomes в gz-daily-pk.yml) тяжёлая, поэтому её
// включает только утренний слот 08:40, остальным PK-диспетчам уходит deal_outcomes=false.
//
// Сторож стоит в 11:30 (06:30 UTC) и 15:15: утренний слот проверяет сбор с начала суток,
// дневной — с 13:00/13:30.
//
// Cloudflare Free allows five cron triggers per account. Три выражения ниже покрывают
// все слоты: расписание «какие workflow запускать» хранится в коде, а не в числе триггеров.
//
// F3 B2B отключён и в GitHub Actions, и здесь.
export interface DispatchTarget {
  workflow: string;
  inputs?: Record<string, string>;
}

const PK_WORKFLOW = "gz-daily-pk.yml";
const MAIN_WORKFLOW = "gz-daily-main.yml";
const WATCHDOG_WORKFLOW = "gz-watchdog.yml";

function collection(dealOutcomes: boolean): DispatchTarget[] {
  return [
    { workflow: PK_WORKFLOW, inputs: { deal_outcomes: String(dealOutcomes) } },
    { workflow: MAIN_WORKFLOW },
  ];
}

// UTC-час, в который cron "30 4-11 * * *" даёт часовой слот (09:30 ... 16:30 Алматы).
const HOURLY_SLOT_HOURS_UTC = [4, 5, 6, 7, 8, 9, 10, 11] as const;
// 06:30 UTC = 11:30 Алматы: к часовому сбору добавляется утренний сторож.
const MORNING_WATCHDOG_HOUR_UTC = 6;

const CRON_MORNING = "40 3 * * *"; // 08:40 Алматы
const CRON_HOURLY = "30 4-11 * * *"; // 09:30 ... 16:30 Алматы
const CRON_AFTERNOON_WATCHDOG = "15 10 * * *"; // 15:15 Алматы

export const SCHEDULED_CRONS = [CRON_MORNING, CRON_HOURLY, CRON_AFTERNOON_WATCHDOG] as const;

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

function targetsForSchedule(cron: string, scheduledTime: number): DispatchTarget[] {
  if (cron === CRON_MORNING) {
    return collection(true);
  }
  if (cron === CRON_AFTERNOON_WATCHDOG) {
    return [{ workflow: WATCHDOG_WORKFLOW, inputs: { window: "afternoon" } }];
  }
  if (cron === CRON_HOURLY) {
    const scheduledHour = new Date(scheduledTime).getUTCHours();
    if (!(HOURLY_SLOT_HOURS_UTC as readonly number[]).includes(scheduledHour)) {
      throw new Error(`Unexpected scheduled time for cron ${cron}: ${scheduledTime}`);
    }
    const targets = collection(false);
    if (scheduledHour === MORNING_WATCHDOG_HOUR_UTC) {
      targets.push({ workflow: WATCHDOG_WORKFLOW });
    }
    return targets;
  }
  throw new Error(`Unknown cron trigger: ${cron}`);
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

async function dispatchOne(
  target: DispatchTarget,
  controller: ScheduledControllerLike,
  token: string,
  dependencies: DispatchDependencies,
): Promise<void> {
  const { workflow, inputs } = target;
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}` +
    `/actions/workflows/${workflow}/dispatches`;
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
    throw new Error(
      `GitHub workflow dispatch of ${workflow} failed with HTTP ${response.status}${suffix}`,
    );
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

export async function dispatchScheduled(
  controller: ScheduledControllerLike,
  env: DispatchEnvironment,
  dependencies: DispatchDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const targets = targetsForSchedule(controller.cron, controller.scheduledTime);
  const token = env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    throw new Error("GITHUB_ACTIONS_TOKEN is not configured");
  }

  // Цели независимы: сбой PK не должен отменять main и наоборот, поэтому ждём все и
  // только потом сообщаем об ошибках. Повторов целого слота нет — повторный
  // workflow_dispatch мог бы запустить полный сбор второй раз.
  const results = await Promise.allSettled(
    targets.map((target) => dispatchOne(target, controller, token, dependencies)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
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
