/**
 * Чтение публичных страниц и файлов портала для помощника: контакты со страницы закупки
 * и текст технической спецификации. Файлы скачиваются только с хостов портала, без перехода
 * по переадресациям на чужие адреса.
 *
 * Страницы `procurement.gov.kz` в Node требуют `NODE_EXTRA_CA_CERTS=certs/rapidssl-tls-rsa-ca-g1.crt`
 * (портал отдаёт цепочку сертификатов без промежуточного).
 */

import JSZip from "jszip";
import { parseAnnounceCustomer, parseAnnounceRepresentative, type AnnounceCustomer, type AnnounceRepresentative } from "../kz/goszakupAnnounceCustomer.js";
import { GZ_PORTAL_ORIGIN } from "../kz/goszakupOrigin.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ALLOWED_FILE_HOSTS = new Set(["ows.goszakup.gov.kz", "v3bl.goszakup.gov.kz", "procurement.gov.kz", "goszakup.gov.kz"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;

export interface AnnouncementContacts {
  announceId: number;
  customer: AnnounceCustomer | null;
  representative: AnnounceRepresentative | null;
}

export type SpecFile =
  | { kind: "docx"; text: string }
  | { kind: "pdf"; base64: string; bytes: number }
  | { kind: "unsupported"; note: string };

export async function fetchAnnouncementContacts(announceId: number, fetchFn: typeof fetch = fetch): Promise<AnnouncementContacts> {
  const response = await fetchFn(`${GZ_PORTAL_ORIGIN}/ru/announce/index/${announceId}`, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Портал ответил HTTP ${response.status} на странице закупки ${announceId}`);
  const html = await response.text();
  return { announceId, customer: parseAnnounceCustomer(html), representative: parseAnnounceRepresentative(html) };
}

/** Только https и хосты портала, без логина в адресе и нестандартного порта. */
export function assertAllowedFileUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Некорректный адрес файла");
  }
  const safe = url.protocol === "https:" && !url.username && !url.password && !url.port && ALLOWED_FILE_HOSTS.has(url.hostname);
  if (!safe) throw new Error("Адрес файла не относится к порталу госзакупок, скачивание запрещено");
  return url;
}

export async function loadSpecFile(rawUrl: string, fetchFn: typeof fetch = fetch): Promise<SpecFile> {
  let url = assertAllowedFileUrl(rawUrl);

  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetchFn(url, { redirect: "manual", headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = assertAllowedFileUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response || !response.ok) throw new Error(`Файл не скачался: HTTP ${response?.status ?? "?"}`);

  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_FILE_BYTES) throw new Error(`Файл слишком большой: размер ${Math.round(declared / 1048576)} МБ, предел 15 МБ`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Файл слишком большой: размер ${Math.round(bytes.length / 1048576)} МБ, предел 15 МБ`);

  if (startsWith(bytes, "%PDF")) return { kind: "pdf", base64: Buffer.from(bytes).toString("base64"), bytes: bytes.length };
  if (startsWith(bytes, "PK")) {
    try {
      return { kind: "docx", text: await extractDocxText(bytes) };
    } catch {
      return { kind: "unsupported", note: "архив не является документом Word (возможно, Excel)" };
    }
  }
  return { kind: "unsupported", note: "формат файла не поддерживается (читаются PDF и Word .docx)" };
}

/** Текст документа Word: по строке на абзац. */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("В архиве нет word/document.xml");
  const xml = await entry.async("string");

  const text = xml
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeXml(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  return prefix.split("").every((char, index) => bytes[index] === char.charCodeAt(0));
}
