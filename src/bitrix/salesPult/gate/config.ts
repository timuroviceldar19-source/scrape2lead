// Роли пульта. Список «почта → роль» лежит в секрете PULT_ROLES, а не в репозитории:
// репозиторий публичный. Модуль без node: — его же собирает промежуточный код Pages.

export type PultRole =
  | { kind: "all" }
  | { kind: "manager"; managerId: string }
  | { kind: "tv" };

export interface PultGateConfig {
  /** Команда Cloudflare Access: <team>.cloudflareaccess.com. */
  team: string;
  /** Application Audience (AUD) Tag приложения Access; без него проверяются подпись и издатель. */
  aud?: string;
  /** Почта в нижнем регистре → роль. */
  users: Record<string, PultRole>;
}

const fail = (message: string): never => {
  throw new Error(`PULT_ROLES: ${message}`);
};

function parseRole(email: string, value: unknown): PultRole {
  if (value === "all") return { kind: "all" };
  if (value === "tv") return { kind: "tv" };
  if (typeof value === "string" && value.startsWith("manager:")) {
    const managerId = value.slice("manager:".length).trim();
    if (!/^\d+$/.test(managerId)) fail(`у ${email} роль manager без числового ID сотрудника Битрикса`);
    return { kind: "manager", managerId };
  }
  return fail(`у ${email} неизвестная роль ${JSON.stringify(value)}: допустимы all, tv, manager:<ID>`);
}

/**
 * Разбирает секрет. Пустой секрет — проверка входа выключена (null). Ошибка в секрете —
 * исключение: лучше упавшая выкладка, чем пульт с неверными ролями.
 */
export function parseGateConfig(raw: string | null | undefined): PultGateConfig | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail("не JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("ожидается объект");
  const { team, aud, users } = data as Record<string, unknown>;
  if (typeof team !== "string" || !/^[a-z0-9-]+$/.test(team)) fail("team — имя команды Access, например my-team");
  if (aud !== undefined && (typeof aud !== "string" || !/^[a-f0-9]{16,128}$/i.test(aud))) fail("aud — AUD-тег приложения Access (hex)");
  if (!users || typeof users !== "object" || Array.isArray(users) || Object.keys(users).length === 0) {
    fail("users — непустой объект «почта: роль»");
  }
  const parsed: Record<string, PultRole> = {};
  for (const [rawEmail, value] of Object.entries(users as Record<string, unknown>)) {
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`«${rawEmail}» не похоже на почту`);
    if (email in parsed) fail(`почта ${email} указана дважды`);
    parsed[email] = parseRole(email, value);
  }
  return { team: team as string, ...(aud ? { aud: (aud as string).toLowerCase() } : {}), users: parsed };
}

/** Папка варианта сайта для роли: _r/<вариант>/index.html и reg.html. */
export function variantOf(role: PultRole): string {
  if (role.kind === "manager") return `m${role.managerId}`;
  return role.kind;
}
