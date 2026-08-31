/**
 * Tech-spec (техническая спецификация) download path for goszakup lots.
 *
 * The announcement "Документация" tab lists document groups in a table:
 *   <tr><td>{doc name}</td><td>{Да/Нет}</td>
 *       <td><button onclick="actionModalShowFiles({annoId},{groupId})">…</button></td></tr>
 * The spec row's name contains "спецификац" and carries a modal button whose
 * second argument is the group id (varies by procurement type — ОК/ЗЦП/ОИ use
 * 3325/125/266 in observed data, so it must never be hardcoded).
 *
 * Opening the modal is a plain AJAX GET:
 *   /ru/announce/actionAjaxModalShowFiles/{annoId}/{groupId}
 * returning a table of files, one per lot:
 *   <tr><td>{lot number}</td><td><a href="…/download_file/…/…/">{file}.pdf</a></td>…</tr>
 *
 * The "Признак" (Да/Нет) column is unreliable and is intentionally ignored —
 * we key off the actual file links instead.
 *
 * All requests are plain HTTP (no Playwright); the pages and PDFs are public.
 */

import { GZ_PORTAL_ORIGIN } from "./goszakupOrigin.js";

const GOSZAKUP_ORIGIN = GZ_PORTAL_ORIGIN;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** A single tech-spec file, associated with a public lot number. */
export interface SpecFile {
  lotNumber: string;
  fileName: string;
  downloadUrl: string;
}

/** Result of resolving the tech-spec document group for an announcement. */
export interface TechSpecResult {
  annoId: string;
  groupId: string | null;
  files: SpecFile[];
}

/**
 * Finds the tech-spec document group id on an announcement "Документация" page.
 * Returns null when no spec row exposes a files modal (e.g. spec not attached).
 */
export function parseSpecGroupId(docsHtml: string): string | null {
  const candidates: Array<{ groupId: string; technical: boolean }> = [];

  for (const rowHtml of iterateRows(docsHtml)) {
    const button = rowHtml.match(/actionModalShowFiles\(\s*\d+\s*,\s*(\d+)\s*\)/i);
    if (!button) continue;

    const name = firstCellText(rowHtml);
    if (!/специфик/i.test(name)) continue;

    candidates.push({ groupId: button[1], technical: /техническ/i.test(name) });
  }

  if (candidates.length === 0) return null;
  const technical = candidates.find((candidate) => candidate.technical);
  return (technical ?? candidates[0]).groupId;
}

/**
 * Parses the files modal table into per-lot spec files.
 * Header rows (with <th>) and rows without a download link are skipped.
 */
export function parseSpecFiles(modalHtml: string): SpecFile[] {
  const files: SpecFile[] = [];

  for (const rowHtml of iterateRows(modalHtml)) {
    if (/<th[\s>]/i.test(rowHtml)) continue;

    const link = rowHtml.match(/<a[^>]+href="([^"]*\/download_file\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const lotNumber = firstCellText(rowHtml);
    const downloadUrl = link[1].trim();
    const fileName = stripTags(link[2]) || fileNameFromUrl(downloadUrl);
    files.push({ lotNumber, fileName, downloadUrl });
  }

  return files;
}

/**
 * Picks the spec file for a given lot number. Falls back to the sole file when
 * the modal carries exactly one (ЗЦП/ОИ single-lot announcements).
 */
export function selectSpecFileForLot(files: SpecFile[], lotNumber: string): SpecFile | null {
  if (files.length === 0) return null;
  const wanted = normalizeLotNumber(lotNumber);
  const exact = files.find((file) => normalizeLotNumber(file.lotNumber) === wanted);
  if (exact) return exact;
  return files.length === 1 ? files[0] : null;
}

/** Fetches the announcement docs page, resolves the spec group, and lists files. */
export async function fetchTechSpecs(annoId: string): Promise<TechSpecResult> {
  const docsHtml = await fetchText(`${GOSZAKUP_ORIGIN}/ru/announce/index/${annoId}?tab=documents`);
  const groupId = parseSpecGroupId(docsHtml);
  if (!groupId) return { annoId, groupId: null, files: [] };

  const modalHtml = await fetchText(
    `${GOSZAKUP_ORIGIN}/ru/announce/actionAjaxModalShowFiles/${annoId}/${groupId}`
  );
  return { annoId, groupId, files: parseSpecFiles(modalHtml) };
}

/** Downloads a spec PDF, validating it is actually a PDF and within size bounds. */
export async function downloadPdf(url: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" } });
  if (!response.ok) throw new Error(`download HTTP ${response.status} for ${url}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(`PDF too large (${buffer.length} bytes > ${maxBytes}) for ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const looksLikePdf = /pdf/i.test(contentType) || buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!looksLikePdf) {
    throw new Error(`not a PDF (content-type "${contentType}") for ${url}`);
  }

  return buffer;
}

/** Extracts the numeric announcement id from an announce URL. */
export function extractAnnounceId(announceUrl: string): string | null {
  return announceUrl.match(/\/announce\/index\/(\d+)/)?.[1] ?? null;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,*/*",
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "ru-RU,ru;q=0.9"
    }
  });
  if (!response.ok) throw new Error(`goszakup HTTP ${response.status} for ${url}`);
  return response.text();
}

function* iterateRows(html: string): Generator<string> {
  const rowPattern = /<tr\b[\s\S]*?<\/tr>/gi;
  for (const match of html.matchAll(rowPattern)) {
    yield match[0];
  }
}

function firstCellText(rowHtml: string): string {
  const cell = rowHtml.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
  return cell ? stripTags(cell[1]) : "";
}

function stripTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function fileNameFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  const tail = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return tail || "techspec.pdf";
}

function normalizeLotNumber(value: string): string {
  return value.replace(/\s+/g, "").toLocaleLowerCase("ru");
}
