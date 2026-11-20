import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { extractText } from "unpdf";
import { decodeHtmlEntities } from "./htmlDom.js";

const execFileAsync = promisify(execFile);

export type SpecFileKind = "pdf" | "docx" | "xlsx" | "zip" | "doc" | "rar" | "unknown" | "error";

export interface ExtractSpecOptions {
  maxPages?: number;
  depth?: number;
}

function stripXmlTags(xml: string, addNewlineBeforeClosingP = false): string {
  const prepared = addNewlineBeforeClosingP ? xml.replace(/<\/w:p>/gi, "\n") : xml;
  return decodeHtmlEntities(prepared.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfBufferText(buffer: Buffer, maxPages: number): Promise<string> {
  const res = await extractText(new Uint8Array(buffer), { mergePages: false });
  const pages = Array.isArray(res.text) ? res.text.slice(0, maxPages) : [String(res.text ?? "")];
  return pages.join("\n").trim();
}

/**
 * Fallback pure-JS text scanner for legacy OLE2 `.doc` files when macOS `textutil` is unavailable (e.g. Linux CI).
 */
function extractLegacyDocFallback(buffer: Buffer): string {
  const chunks: string[] = [];
  // Scan UTF-16LE sequences of Cyrillic/Latin text
  let current = "";
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = buffer.readUInt16LE(i);
    if (
      (code >= 0x0400 && code <= 0x04ff) ||
      (code >= 0x0020 && code <= 0x007e) ||
      code === 0x000a ||
      code === 0x000d
    ) {
      current += String.fromCharCode(code);
    } else {
      if (current.length >= 16 && /[А-Яа-яA-Za-z]{4,}/.test(current)) {
        chunks.push(current.trim());
      }
      current = "";
    }
  }
  if (current.length >= 16 && /[А-Яа-яA-Za-z]{4,}/.test(current)) {
    chunks.push(current.trim());
  }
  return chunks.join("\n").trim();
}

async function extractLegacyDocText(buffer: Buffer): Promise<string> {
  if (process.platform === "darwin") {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "comp-doc-"));
    const tmpPath = path.join(tmpDir, "spec.doc");
    try {
      await fs.writeFile(tmpPath, buffer);
      const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", tmpPath], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000
      });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // Fallback to pure JS scanner below
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return extractLegacyDocFallback(buffer);
}

/**
 * Detects file format by magic bytes (`.pdf` uploads on Goszakup can be DOCX, XLSX, ZIP, or DOC)
 * and extracts plain text without shell-only assumptions.
 */
export async function extractSpecText(
  buffer: Buffer,
  options: ExtractSpecOptions = {}
): Promise<{ kind: SpecFileKind; text: string }> {
  const maxPages = options.maxPages ?? 60;
  const depth = options.depth ?? 0;
  if (!buffer || buffer.length < 4) return { kind: "unknown", text: "" };

  try {
    const head4 = buffer.subarray(0, 4);
    if (head4.toString("latin1") === "%PDF") {
      return { kind: "pdf", text: await extractPdfBufferText(buffer, maxPages) };
    }
    if (head4[0] === 0x50 && head4[1] === 0x4b && head4[2] === 0x03 && head4[3] === 0x04) {
      const zip = await JSZip.loadAsync(buffer);
      const names = Object.keys(zip.files);
      const docXml = zip.file("word/document.xml");
      if (docXml) {
        const xml = await docXml.async("string");
        return { kind: "docx", text: stripXmlTags(xml, true) };
      }
      if (names.some((n) => n.startsWith("xl/"))) {
        const xlNames = names.filter((n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/.*\.xml$/i.test(n));
        const parts: string[] = [];
        for (const n of xlNames) {
          const entry = zip.file(n);
          if (entry) parts.push(stripXmlTags(await entry.async("string"), false));
        }
        return { kind: "xlsx", text: parts.join("\n").trim() };
      }
      if (depth > 0) return { kind: "zip", text: "" };
      const texts: string[] = [];
      for (const n of names) {
        const entry = zip.file(n);
        if (!entry || entry.dir) continue;
        try {
          const innerBuf = await entry.async("nodebuffer");
          const inner = await extractSpecText(innerBuf, { maxPages, depth: depth + 1 });
          if (inner.text) texts.push(inner.text);
        } catch {
          // Skip broken nested entry
        }
      }
      return { kind: "zip", text: texts.join("\n").trim() };
    }
    if (head4[0] === 0xd0 && head4[1] === 0xcf && head4[2] === 0x11 && head4[3] === 0xe0) {
      return { kind: "doc", text: depth === 0 ? await extractLegacyDocText(buffer) : "" };
    }
    if (head4.toString("latin1") === "Rar!") {
      return { kind: "rar", text: "" };
    }
    return { kind: "unknown", text: "" };
  } catch {
    return { kind: "error", text: "" };
  }
}
