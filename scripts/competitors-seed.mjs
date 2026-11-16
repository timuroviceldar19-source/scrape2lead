#!/usr/bin/env node
/**
 * Зашифрованная копия базы конкурентов (data/competitors/competitors.db) для первой заливки в кэш Actions.
 *
 * Полный сбор с IP GitHub не укладывается в лимит задачи (портал режет запросы к протоколам и ТС),
 * поэтому базу собирают на своей машине и один раз заливают через черновик релиза `competitors-seed`.
 * Репозиторий публичный: в релиз кладётся только зашифрованный файл, ключ — секрет COMPETITORS_SEED_KEY.
 *
 *   COMPETITORS_SEED_KEY=<base64, 32 байта> node scripts/competitors-seed.mjs pack   <база> <файл.enc>
 *   COMPETITORS_SEED_KEY=<base64, 32 байта> node scripts/competitors-seed.mjs unpack <файл.enc> <база> [--expect-sqlite]
 *
 * Формат: "S2LSEED1" | IV 12 байт | gzip(база), зашифрованная AES-256-GCM | тег 16 байт.
 * Скрипт без зависимостей: задача заливки работает с правом записи в репозиторий и не ставит npm-пакеты.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const MAGIC = Buffer.from("S2LSEED1", "latin1");
const IV_LEN = 12;
const TAG_LEN = 16;
const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "latin1");

function parseKey(keyB64) {
  const key = Buffer.from(String(keyB64 ?? "").trim(), "base64");
  if (key.length !== 32) {
    throw new Error("COMPETITORS_SEED_KEY должен быть 32 байтами в base64 (например, `openssl rand -base64 32`)");
  }
  return key;
}

export async function packSeed(inPath, outPath, keyB64) {
  const key = parseKey(keyB64);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const tmp = `${outPath}.tmp`;
  try {
    const out = fs.createWriteStream(tmp);
    out.write(Buffer.concat([MAGIC, iv]));
    await pipeline(fs.createReadStream(inPath), zlib.createGzip({ level: 9 }), cipher, out, { end: false });
    await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, outPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export async function unpackSeed(inPath, outPath, keyB64, options = {}) {
  const key = parseKey(keyB64);
  const size = fs.statSync(inPath).size;
  const headLen = MAGIC.length + IV_LEN;
  if (size < headLen + TAG_LEN) throw new Error("Файл копии базы слишком короткий");
  const fd = fs.openSync(inPath, "r");
  const head = Buffer.alloc(headLen);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, head, 0, headLen, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Это не копия базы конкурентов (нет метки S2LSEED1)");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const tmp = `${outPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    await pipeline(
      fs.createReadStream(inPath, { start: headLen, end: size - TAG_LEN - 1 }),
      decipher,
      zlib.createGunzip(),
      fs.createWriteStream(tmp)
    );
    if (options.expectSqlite) {
      const fdOut = fs.openSync(tmp, "r");
      const first = Buffer.alloc(SQLITE_HEADER.length);
      try {
        fs.readSync(fdOut, first, 0, first.length, 0);
      } finally {
        fs.closeSync(fdOut);
      }
      if (!first.equals(SQLITE_HEADER)) throw new Error("Расшифрованный файл не похож на базу SQLite");
    }
    fs.renameSync(tmp, outPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function main(argv) {
  const [cmd, inPath, outPath, ...rest] = argv;
  if (!["pack", "unpack"].includes(cmd) || !inPath || !outPath) {
    console.error("Использование: node scripts/competitors-seed.mjs pack|unpack <вход> <выход> [--expect-sqlite]");
    return 2;
  }
  const keyB64 = process.env.COMPETITORS_SEED_KEY;
  if (!keyB64) {
    console.error("Не задан COMPETITORS_SEED_KEY");
    return 2;
  }
  try {
    if (cmd === "pack") {
      await packSeed(inPath, outPath, keyB64);
    } else {
      await unpackSeed(inPath, outPath, keyB64, { expectSqlite: rest.includes("--expect-sqlite") });
    }
    const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`[Конкуренты] ${cmd === "pack" ? "Копия базы упакована" : "Копия базы распакована"}: ${outPath} (${mb} МБ)`);
    return 0;
  } catch (err) {
    console.error(`[Конкуренты] Ошибка копии базы: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
