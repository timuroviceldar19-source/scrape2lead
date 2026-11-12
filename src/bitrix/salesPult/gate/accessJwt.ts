// Проверка токена Cloudflare Access (RS256) по ключам команды. Только Web Crypto и fetch:
// модуль работает и в Node (тесты), и в Workers (промежуточный код Pages).

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface CachedKeys {
  team: string;
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
  /** Когда последний раз перечитывали ключи из-за неизвестного kid. */
  missRefetchAt?: number;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
/** После неудачного перечитывания ключей не ходим за ними снова раньше, чем через минуту. */
const REFETCH_GAP_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

let cache: CachedKeys | null = null;

export function clearJwksCache(): void {
  cache = null;
}

function decodePart(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(decodePart(part)));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function loadKeys(team: string, fetchFn: typeof fetch, now: number): Promise<CachedKeys> {
  const res = await fetchFn(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  const keys = new Map<string, CryptoKey>();
  if (res.ok) {
    const body = await res.json() as { keys?: Jwk[] };
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      try {
        const { kid, ...material } = jwk;
        keys.set(kid, await crypto.subtle.importKey(
          "jwk", { ...material, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
        ));
      } catch {
        // Битый ключ пропускаем: остальные ключи команды продолжают работать.
      }
    }
  }
  return { team, fetchedAt: now, keys };
}

async function keyFor(kid: string, team: string, fetchFn: typeof fetch, now: number): Promise<CryptoKey | undefined> {
  const stale = !cache || cache.team !== team || now - cache.fetchedAt > KEYS_TTL_MS;
  if (stale) cache = await loadKeys(team, fetchFn, now);
  let key = cache!.keys.get(kid);
  const lastMiss = cache!.missRefetchAt;
  if (!key && !stale && (lastMiss === undefined || now - lastMiss > REFETCH_GAP_MS)) {
    // Команда могла сменить ключ: перечитываем, но не чаще раза в минуту.
    cache = { ...(await loadKeys(team, fetchFn, now)), missRefetchAt: now };
    key = cache.keys.get(kid);
  }
  return key;
}

export interface VerifyOptions {
  team: string;
  aud?: string;
  fetchFn?: typeof fetch;
  /** Миллисекунды; для тестов. */
  now?: number;
}

/** Почта из действительного токена Access или null. */
export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<{ email: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[2]) return null;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const now = options.now ?? Date.now();
  let key: CryptoKey | undefined;
  try {
    key = await keyFor(header.kid, options.team, options.fetchFn ?? fetch, now);
  } catch {
    return null;
  }
  if (!key) return null;

  let valid = false;
  try {
    const signature = decodePart(parts[2]);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, data as BufferSource);
  } catch {
    return null;
  }
  if (!valid) return null;

  const seconds = now / 1000;
  if (claims.iss !== `https://${options.team}.cloudflareaccess.com`) return null;
  if (typeof claims.exp !== "number" || claims.exp < seconds - CLOCK_SKEW_S) return null;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + CLOCK_SKEW_S) return null;
  if (options.aud) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === "string" && a.toLowerCase() === options.aud)) return null;
  }
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return null;
  return { email: claims.email.trim().toLowerCase() };
}
