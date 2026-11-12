// Проверка входа на пульт: кто пришёл (токен Cloudflare Access) → роль → вариант сайта.
// Варианты лежат в статике Pages как _r/<вариант>/index.html и reg.html; напрямую по этим
// адресам их не отдаём, иначе роль можно было бы обойти.

import { variantOf, type PultGateConfig } from "./config.js";
import { verifyAccessJwt } from "./accessJwt.js";

export interface GateAssets {
  fetch(input: Request | string | URL): Promise<Response>;
}

export interface GateDeps {
  /** null — проверка выключена (секрет PULT_ROLES не задан), все видят полный пульт. */
  config: PultGateConfig | null;
  assets: GateAssets;
  fetchFn?: typeof fetch;
  now?: () => number;
}

type Page = "index" | "reg";

const PAGES: Record<string, Page> = {
  "/": "index",
  "/index.html": "index",
  "/reg": "reg",
  "/reg/": "reg",
  "/reg.html": "reg"
};

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff"
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function notice(status: number, title: string, lines: string[], links: string): Response {
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Пульт продаж F3</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f1;--ink:#1d1d1b;--ink2:#5d5b55;--line:#dedbd2}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--ink:#f1efe8;--ink2:#a9a69c;--line:#34332e}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:16px;padding:28px;border:1px solid var(--line);border-radius:14px}
h1{margin:0 0 12px;font-size:22px}p{margin:0 0 10px;color:var(--ink2)}b{color:var(--ink)}
nav{margin-top:18px;display:flex;gap:16px;flex-wrap:wrap}a{color:inherit}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${l}</p>`).join("")}<nav>${links}</nav></main></body></html>`;
  return new Response(html, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
}

const LOGOUT = '<a href="/cdn-cgi/access/logout">Войти под другой почтой</a>';

function denied(email: string | null): Response {
  const who = email ? `Вы вошли как <b>${escapeHtml(email)}</b>.` : "Не удалось проверить вход.";
  return notice(403, "Нет доступа", [who, "Этой почты нет в списке доступа к пульту. Напишите руководителю отдела продаж."], LOGOUT);
}

function notReady(): Response {
  return notice(403, "Пульт для вас ещё не готов", ["Ваша роль уже задана, но её вид пульта ещё не собран. Загляните позже."], LOGOUT);
}

function pageClosed(): Response {
  return notice(403, "Эта страница вам недоступна", ["Остальной пульт открыт."], '<a href="./">Открыть пульт</a>');
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header.trim();
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? match[1].trim() : null;
}

/** Статика Pages отдаёт index.html по папке, а *.html переадресует на адрес без расширения. */
async function fetchAsset(assets: GateAssets, origin: string, pathname: string): Promise<Response> {
  let url = new URL(pathname, origin);
  for (let hop = 0; hop < 3; hop++) {
    const res = await assets.fetch(new Request(url.toString(), { method: "GET" }));
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    const next = new URL(location, url);
    if (next.origin !== url.origin || !next.pathname.startsWith("/_r/")) return new Response("not found", { status: 404 });
    url = next;
  }
  return new Response("not found", { status: 404 });
}

export async function handleGateRequest(request: Request, deps: GateDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { ...SECURITY_HEADERS, allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const page = PAGES[url.pathname];
  if (!page) return new Response("not found", { status: 404, headers: SECURITY_HEADERS });

  let variant = "all";
  if (deps.config) {
    const token = tokenFrom(request);
    const who = token
      ? await verifyAccessJwt(token, { team: deps.config.team, aud: deps.config.aud, fetchFn: deps.fetchFn, now: deps.now?.() })
      : null;
    if (!who) return denied(null);
    const role = deps.config.users[who.email];
    if (!role) return denied(who.email);
    variant = variantOf(role);
  }

  const asset = await fetchAsset(deps.assets, url.origin, page === "index" ? `/_r/${variant}/` : `/_r/${variant}/reg`);
  if (asset.status === 404) {
    if (page === "index") return notReady();
    const index = await fetchAsset(deps.assets, url.origin, `/_r/${variant}/`);
    return index.ok ? pageClosed() : notReady();
  }
  if (!asset.ok) return new Response("upstream error", { status: 502, headers: SECURITY_HEADERS });

  const headers = { ...SECURITY_HEADERS, "content-type": asset.headers.get("content-type") ?? "text/html; charset=utf-8" };
  return new Response(request.method === "HEAD" ? null : asset.body, { status: 200, headers });
}
