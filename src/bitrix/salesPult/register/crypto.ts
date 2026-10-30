import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RegisterHistoryPayload } from "./types.js";

export const DEFAULT_REGISTER_CACHE_DIR = "data/register";
export const DEFAULT_REGISTER_HISTORY_PATH = "data/register/history.json";
export const DEFAULT_REGISTER_ATTEMPT_PATH = "data/register/last_attempt.json";

export interface RegisterAttemptRecord {
  success: boolean;
  error?: string;
  timestamp: string;
}

export function recordRegisterHistoryAttempt(
  attemptFilePath = DEFAULT_REGISTER_ATTEMPT_PATH,
  result: { success: boolean; error?: string; timestamp?: string }
): void {
  try {
    const resolved = path.resolve(attemptFilePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const record: RegisterAttemptRecord = {
      success: result.success,
      error: result.error,
      timestamp: result.timestamp || new Date().toISOString()
    };
    fs.writeFileSync(resolved, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    console.warn(`[Реестр] Не удалось записать статус попытки ${attemptFilePath}:`, err);
  }
}

export function loadRegisterHistoryAttempt(
  attemptFilePath = DEFAULT_REGISTER_ATTEMPT_PATH
): RegisterAttemptRecord | null {
  try {
    const resolved = path.resolve(attemptFilePath);
    if (!fs.existsSync(resolved)) return null;
    const raw = fs.readFileSync(resolved, "utf8");
    return JSON.parse(raw) as RegisterAttemptRecord;
  } catch {
    return null;
  }
}

export interface EncryptedHistoryEnvelope {
  v: number;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export interface LoadHistoryResult {
  payload?: RegisterHistoryPayload;
  error?: string;
  source: "cache" | "none";
}

export function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret.trim()).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 */
export function encryptPayload(plaintext: string, secretKey: string): string {
  if (!secretKey || !secretKey.trim()) {
    throw new Error("Secret key is required for encryption");
  }
  const key = deriveKey(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedHistoryEnvelope = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: ciphertext.toString("base64")
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypts an encrypted envelope string using AES-256-GCM.
 */
export function decryptPayload(encryptedJson: string, secretKey: string): string {
  if (!secretKey || !secretKey.trim()) {
    throw new Error("Secret key is required for decryption");
  }
  const envelope = JSON.parse(encryptedJson) as EncryptedHistoryEnvelope;
  if (!envelope || envelope.alg !== "aes-256-gcm" || !envelope.iv || !envelope.tag || !envelope.data) {
    throw new Error("Неверный формат зашифрованного кэша истории");
  }

  const key = deriveKey(secretKey);
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

/**
 * Saves history payload encrypted to disk.
 * Returns false without creating a file if secret key is missing.
 */
export function saveEncryptedRegisterHistory(
  filePath: string,
  history: RegisterHistoryPayload,
  key = process.env.REGISTER_HISTORY_KEY
): boolean {
  if (!key || !key.trim()) {
    console.warn("[Реестр] REGISTER_HISTORY_KEY не задан, зашифрованный кэш не сохранён");
    return false;
  }
  try {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const plaintext = JSON.stringify(history);
    const encrypted = encryptPayload(plaintext, key);
    fs.writeFileSync(resolved, encrypted, "utf8");
    return true;
  } catch (err) {
    console.warn(`[Реестр] Не удалось сохранить зашифрованный кэш ${filePath}:`, err);
    return false;
  }
}

/**
 * Loads history payload from encrypted cache file.
 */
export function loadEncryptedRegisterHistory(
  filePath: string,
  key = process.env.REGISTER_HISTORY_KEY
): LoadHistoryResult {
  if (!key || !key.trim()) {
    return {
      error: "История недоступна: не задан ключ кэша",
      source: "none"
    };
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { source: "none" };
  }
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const decrypted = decryptPayload(raw, key);
    const parsed = JSON.parse(decrypted) as RegisterHistoryPayload;
    return { payload: parsed, source: "cache" };
  } catch (err) {
    console.warn(`[Реестр] Ошибка расшифровки кэша истории (${filePath}):`, err);
    return {
      error: "История недоступна: ошибка расшифровки кэша (неверный ключ или повреждён файл)",
      source: "none"
    };
  }
}

export interface ShouldRefreshHistoryOptions {
  cacheFilePath: string;
  attemptFilePath?: string;
  nowIso?: string;
  forceRefresh?: boolean;
}

/**
 * Determines whether register history should be rebuilt from Disk:
 * - forceRefresh is true -> true
 * - last attempt failed < 1 hour ago -> false
 * - cache file doesn't exist -> true
 * - cache file age >= 20 hours -> true
 * - current Almaty time >= 08:00 and cache file was created before 08:00 today (or yesterday) -> true
 * - otherwise -> false (fast 15-min site mode run reads cache)
 */
export function shouldRefreshRegisterHistory(options: ShouldRefreshHistoryOptions): boolean {
  if (options.forceRefresh) return true;

  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const nowMs = now.getTime();

  // If previous attempt failed recently (< 1 hour ago), do not retry unless forced
  const attemptPath =
    options.attemptFilePath ||
    path.join(path.dirname(options.cacheFilePath), "last_attempt.json");
  const lastAttempt = loadRegisterHistoryAttempt(attemptPath);
  if (lastAttempt && !lastAttempt.success && lastAttempt.timestamp) {
    const attemptTime = Date.parse(lastAttempt.timestamp);
    const ONE_HOUR_MS = 60 * 60 * 1000;
    if (nowMs - attemptTime < ONE_HOUR_MS) {
      return false;
    }
  }

  const resolved = path.resolve(options.cacheFilePath);
  if (!fs.existsSync(resolved)) return true;

  const stats = fs.statSync(resolved);
  const mtimeMs = stats.mtime.getTime();
  const ageMs = nowMs - mtimeMs;

  const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;
  if (ageMs >= TWENTY_HOURS_MS) return true;

  // Almaty is UTC+5 (300 min offset)
  const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;
  const nowAlmaty = new Date(nowMs + ALMATY_OFFSET_MS);
  const mtimeAlmaty = new Date(mtimeMs + ALMATY_OFFSET_MS);

  const almatyHour = nowAlmaty.getUTCHours();
  if (almatyHour >= 8) {
    // Today's 08:00 Almaty in UTC ms
    const todayAlmatyYear = nowAlmaty.getUTCFullYear();
    const todayAlmatyMonth = nowAlmaty.getUTCMonth();
    const todayAlmatyDate = nowAlmaty.getUTCDate();
    const today0800AlmatyMs = Date.UTC(todayAlmatyYear, todayAlmatyMonth, todayAlmatyDate, 8, 0, 0) - ALMATY_OFFSET_MS;

    if (mtimeMs < today0800AlmatyMs) {
      return true;
    }
  }

  return false;
}
