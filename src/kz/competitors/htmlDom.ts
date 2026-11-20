export interface HtmlCell {
  text: string;
  html: string;
  isHeader: boolean;
}

export interface HtmlRow {
  cells: HtmlCell[];
  rawHtml: string;
}

export interface HtmlTable {
  rows: HtmlRow[];
  rawHtml: string;
  startIndex: number;
  endIndex: number;
}

const ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  laquo: "«",
  raquo: "»",
  ndash: "–",
  mdash: "—"
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&([a-zA-Z]+);/g, (full, name: string) => ENTITY_MAP[name.toLowerCase()] ?? full)
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

export function cleanHtmlText(htmlFragment: string): string {
  return decodeHtmlEntities(
    htmlFragment
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRuNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = String(text).replace(/\u00a0/g, "").replace(/\s+/g, "").replace(",", ".");
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

export function cleanBin(text: string | null | undefined): string {
  const digits = String(text ?? "").replace(/\D/g, "");
  return digits.length === 12 ? digits : "";
}

/**
 * Finds all top-level `<table>...</table>` ranges (ignoring nested tables inside cells).
 */
export function findTopLevelTableRanges(html: string): Array<{ start: number; end: number }> {
  const tagRe = /<\/?table\b[^>]*>/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let topStart = -1;

  for (const match of html.matchAll(tagRe)) {
    const tag = match[0];
    const idx = match.index ?? 0;
    const isClosing = tag.startsWith("</");
    if (!isClosing) {
      if (depth === 0) topStart = idx;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && topStart >= 0) {
        ranges.push({ start: topStart, end: idx + tag.length });
        topStart = -1;
      }
    }
  }
  return ranges;
}

/**
 * Extracts rows and cells from a single table HTML, ignoring any nested tables inside cells.
 */
export function parseTableHtml(tableHtml: string, startIndex = 0, endIndex = tableHtml.length): HtmlTable {
  const rows: HtmlRow[] = [];
  // Strip nested tables so inner <tr>/<td> don't pollute outer rows.
  const withoutNested = stripNestedTables(tableHtml);
  const trChunks = extractTagBlocks(withoutNested, "tr");
  for (const rowChunk of trChunks) {
    const cells: HtmlCell[] = [];
    const cellRe = /<(td|th)\b[^>]*>/gi;
    const cellStarts: Array<{ tag: "td" | "th"; openEnd: number; openStart: number }> = [];
    for (const m of rowChunk.inner.matchAll(cellRe)) {
      cellStarts.push({
        tag: m[1].toLowerCase() as "td" | "th",
        openStart: m.index ?? 0,
        openEnd: (m.index ?? 0) + m[0].length
      });
    }
    for (let i = 0; i < cellStarts.length; i++) {
      const cur = cellStarts[i];
      const boundary = i + 1 < cellStarts.length ? cellStarts[i + 1].openStart : rowChunk.inner.length;
      const segment = rowChunk.inner.slice(cur.openEnd, boundary);
      const closeRe = new RegExp(`<\\/${cur.tag}\\s*>`, "i");
      const closeMatch = segment.match(closeRe);
      const cellInner = closeMatch && closeMatch.index !== undefined ? segment.slice(0, closeMatch.index) : segment;
      cells.push({
        isHeader: cur.tag === "th",
        html: cellInner,
        text: cleanHtmlText(cellInner)
      });
    }
    if (cells.length > 0) {
      rows.push({ cells, rawHtml: rowChunk.raw });
    }
  }
  return { rows, rawHtml: tableHtml, startIndex, endIndex };
}

function extractTagBlocks(html: string, tagName: string): Array<{ inner: string; raw: string }> {
  const blocks: Array<{ inner: string; raw: string }> = [];
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const starts: Array<{ openStart: number; openEnd: number }> = [];
  for (const m of html.matchAll(openRe)) {
    starts.push({ openStart: m.index ?? 0, openEnd: (m.index ?? 0) + m[0].length });
  }
  const closeRe = new RegExp(`<\\/${tagName}\\s*>`, "i");
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    const boundary = i + 1 < starts.length ? starts[i + 1].openStart : html.length;
    const segment = html.slice(cur.openEnd, boundary);
    const closeMatch = segment.match(closeRe);
    const innerEnd = closeMatch && closeMatch.index !== undefined ? cur.openEnd + closeMatch.index : boundary;
    const rawEnd = closeMatch && closeMatch.index !== undefined ? innerEnd + closeMatch[0].length : boundary;
    blocks.push({ inner: html.slice(cur.openEnd, innerEnd), raw: html.slice(cur.openStart, rawEnd) });
  }
  return blocks;
}

function stripNestedTables(tableHtml: string): string {
  const tagRe = /<\/?table\b[^>]*>/gi;
  let depth = 0;
  let innerStart = -1;
  const spansToRemove: Array<[number, number]> = [];
  for (const match of tableHtml.matchAll(tagRe)) {
    const tag = match[0];
    const idx = match.index ?? 0;
    if (!tag.startsWith("</")) {
      if (depth === 1) innerStart = idx;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 1 && innerStart >= 0) {
        spansToRemove.push([innerStart, idx + tag.length]);
        innerStart = -1;
      }
    }
  }
  if (spansToRemove.length === 0) return tableHtml;
  let out = "";
  let pos = 0;
  for (const [s, e] of spansToRemove) {
    out += tableHtml.slice(pos, s) + " ";
    pos = e;
  }
  return out + tableHtml.slice(pos);
}

export function extractAllTopLevelTables(html: string): HtmlTable[] {
  return findTopLevelTableRanges(html).map(({ start, end }) =>
    parseTableHtml(html.slice(start, end), start, end)
  );
}

export type ProtocolNode =
  | { kind: "table"; table: HtmlTable; headerText: string }
  | { kind: "text"; text: string };

/**
 * Walks top-level tables and non-table block text nodes in document order (mirroring lxml's body traversal).
 */
export function extractDocumentNodes(html: string): ProtocolNode[] {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const tables = extractAllTopLevelTables(body);
  const nodes: ProtocolNode[] = [];

  const pushTextBlocks = (chunk: string) => {
    const parts = chunk.split(/<\/?(?:p|h[1-6]|div|br|li|section|article|header|footer)\b[^>]*>/gi);
    for (const part of parts) {
      const txt = cleanHtmlText(part);
      if (txt) nodes.push({ kind: "text", text: txt });
    }
  };

  let cursor = 0;
  for (const table of tables) {
    if (table.startIndex > cursor) {
      pushTextBlocks(body.slice(cursor, table.startIndex));
    }
    const firstRow = table.rows[0];
    const headerText = firstRow ? firstRow.cells.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim() : "";
    nodes.push({ kind: "table", table, headerText });
    cursor = table.endIndex;
  }
  if (cursor < body.length) {
    pushTextBlocks(body.slice(cursor));
  }

  return nodes;
}

export function extractAttribute(tagHtml: string, attr: string): string {
  const re = new RegExp(`\\b${attr}=(["'])([\\s\\S]*?)\\1`, "i");
  const m = tagHtml.match(re);
  return m ? decodeHtmlEntities(m[2]).trim() : "";
}
