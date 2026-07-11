import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderPdfPages, type CommandRunner } from "../../src/analysis/pdfRenderer.js";

describe("renderPdfPages", () => {
  it("renders ordered JPEG pages and removes its temporary work directory", async () => {
    const tempRoot = path.resolve("tmp", "pdfs-test");
    await fs.rm(tempRoot, { recursive: true, force: true });

    const runCommand = vi.fn<CommandRunner>(async (command, args) => {
      if (command === "pdfinfo") return { stdout: "Pages:          2\n", stderr: "" };
      const prefix = args.at(-1);
      if (!prefix) throw new Error("missing output prefix");
      await fs.writeFile(`${prefix}-2.jpg`, Buffer.from("page-two"));
      await fs.writeFile(`${prefix}-1.jpg`, Buffer.from("page-one"));
      return { stdout: "", stderr: "" };
    });

    const pages = await renderPdfPages(Buffer.from("%PDF-test"), { tempRoot, runCommand });

    expect(pages).toEqual([
      { pageNumber: 1, mediaType: "image/jpeg", base64: Buffer.from("page-one").toString("base64") },
      { pageNumber: 2, mediaType: "image/jpeg", base64: Buffer.from("page-two").toString("base64") }
    ]);
    expect(runCommand).toHaveBeenCalledTimes(2);
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects documents above the configured page limit before rendering", async () => {
    const tempRoot = path.resolve("tmp", "pdfs-test-limit");
    await fs.rm(tempRoot, { recursive: true, force: true });
    const runCommand = vi.fn<CommandRunner>(async () => ({ stdout: "Pages: 31\n", stderr: "" }));

    await expect(renderPdfPages(Buffer.from("%PDF-test"), {
      tempRoot,
      maxPages: 30,
      runCommand
    })).rejects.toThrow(/31 pages.*limit is 30/i);

    expect(runCommand).toHaveBeenCalledOnce();
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects empty input and invalid render settings", async () => {
    await expect(renderPdfPages(Buffer.alloc(0))).rejects.toThrow(/empty PDF/);
    await expect(renderPdfPages(Buffer.from("pdf"), { maxPages: 0 })).rejects.toThrow(/page limit/);
    await expect(renderPdfPages(Buffer.from("pdf"), { jpegQuality: 101 })).rejects.toThrow(/JPEG quality/);
  });

  it("fails cleanly when pdfinfo does not report a page count", async () => {
    const tempRoot = path.resolve("tmp", "pdfs-test-invalid-info");
    await fs.rm(tempRoot, { recursive: true, force: true });
    const runCommand = vi.fn<CommandRunner>(async () => ({ stdout: "Title: test\n", stderr: "" }));

    await expect(renderPdfPages(Buffer.from("%PDF-test"), { tempRoot, runCommand }))
      .rejects.toThrow(/valid page count/);

    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});
