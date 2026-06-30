import type { HarvestBinCandidate } from "./binValidation.js";

/** Parse supplier search results table — one row per participant. */
export function parseRegistrySearchRows(html: string): HarvestBinCandidate[] {
  const rows = extractTableRows(html);
  const results: HarvestBinCandidate[] = [];

  for (const row of rows) {
    const cells = extractCells(row);
    if (cells.length < 2) continue;

    const binCell = cells.find((cell) => /^\d{12}$/.test(cell.replace(/\s/g, "")));
    if (!binCell) continue;

    const bin = binCell.replace(/\s/g, "");
    const linkMatch = row.match(/show_supplier\/(\d+)/);
    const participant_id = linkMatch?.[1] ?? null;

    const nameCandidates = cells.filter((cell) => cell.replace(/\s/g, "") !== bin && !/^\d+$/.test(cell.trim()));
    const name = nameCandidates.sort((a, b) => b.length - a.length)[0] ?? "";

    if (!name) continue;
    results.push({ bin, name, participant_id });
  }

  return results;
}

function extractTableRows(html: string): string[] {
  const rows: string[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(html)) !== null) {
    rows.push(match[1]);
  }
  return rows;
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>|<div\s+class=["']divTableCell["'][^>]*>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(rowHtml)) !== null) {
    cells.push(cleanHtmlText(match[1] ?? match[2] ?? ""));
  }
  return cells;
}

function cleanHtmlText(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
