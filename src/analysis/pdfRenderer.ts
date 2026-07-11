import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RenderedPdfPage {
  pageNumber: number;
  mediaType: "image/jpeg" | "image/png";
  base64: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface PdfRenderOptions {
  tempRoot?: string;
  maxPages?: number;
  dpi?: number;
  jpegQuality?: number;
  pdfinfoPath?: string;
  pdftoppmPath?: string;
  runCommand?: CommandRunner;
}

const DEFAULT_TEMP_ROOT = path.resolve("tmp", "pdfs");
const DEFAULT_MAX_PAGES = 30;
const DEFAULT_DPI = 150;
const DEFAULT_JPEG_QUALITY = 88;

/**
 * Renders all pages of a bounded PDF to JPEG images with Poppler.
 * Temporary input/output files are removed on success and failure.
 */
export async function renderPdfPages(pdf: Buffer, options: PdfRenderOptions = {}): Promise<RenderedPdfPage[]> {
  const tempRoot = options.tempRoot ?? process.env.SPEC_PDF_TEMP_DIR?.trim() ?? DEFAULT_TEMP_ROOT;
  const maxPages = options.maxPages ?? positiveInt(process.env.SPEC_PDF_MAX_PAGES, DEFAULT_MAX_PAGES);
  const dpi = options.dpi ?? positiveInt(process.env.SPEC_PDF_DPI, DEFAULT_DPI);
  const jpegQuality = options.jpegQuality ?? positiveInt(process.env.SPEC_PDF_JPEG_QUALITY, DEFAULT_JPEG_QUALITY);
  const pdfinfoPath = options.pdfinfoPath ?? process.env.PDFINFO_PATH?.trim() ?? "pdfinfo";
  const pdftoppmPath = options.pdftoppmPath ?? process.env.PDFTOPPM_PATH?.trim() ?? "pdftoppm";
  const runCommand = options.runCommand ?? defaultCommandRunner;

  if (pdf.length === 0) throw new Error("cannot render an empty PDF");
  if (maxPages < 1) throw new Error("PDF page limit must be positive");
  if (jpegQuality < 1 || jpegQuality > 100) throw new Error("PDF JPEG quality must be between 1 and 100");

  await fs.mkdir(tempRoot, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(tempRoot, "spec-"));
  const inputPath = path.join(workDir, "input.pdf");
  const outputPrefix = path.join(workDir, "page");

  try {
    await fs.writeFile(inputPath, pdf);
    const info = await runCommand(pdfinfoPath, [inputPath]);
    const pageCount = parsePdfPageCount(info.stdout);
    if (pageCount > maxPages) {
      throw new Error(`PDF has ${pageCount} pages; configured limit is ${maxPages}`);
    }

    await runCommand(pdftoppmPath, [
      "-jpeg",
      "-jpegopt",
      `quality=${jpegQuality}`,
      "-r",
      String(dpi),
      inputPath,
      outputPrefix
    ]);

    const renderedFiles = (await fs.readdir(workDir))
      .map((name) => ({ name, match: name.match(/^page-(\d+)\.jpg$/i) }))
      .filter((item): item is { name: string; match: RegExpMatchArray } => item.match !== null)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

    if (renderedFiles.length !== pageCount) {
      throw new Error(`Poppler rendered ${renderedFiles.length} pages; expected ${pageCount}`);
    }

    return Promise.all(renderedFiles.map(async ({ name, match }) => ({
      pageNumber: Number(match[1]),
      mediaType: "image/jpeg" as const,
      base64: (await fs.readFile(path.join(workDir, name))).toString("base64")
    })));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export function parsePdfPageCount(pdfinfoOutput: string): number {
  const match = pdfinfoOutput.match(/^Pages:\s*(\d+)\s*$/im);
  const count = match ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(count) || count < 1) {
    throw new Error("pdfinfo did not report a valid page count");
  }
  return count;
}

const defaultCommandRunner: CommandRunner = async (command, args) => {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const details = error as NodeJS.ErrnoException & { stderr?: string };
    const suffix = details.stderr?.trim() ? `: ${details.stderr.trim()}` : "";
    throw new Error(`failed to run ${command}${suffix || `: ${details.message}`}`);
  }
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
