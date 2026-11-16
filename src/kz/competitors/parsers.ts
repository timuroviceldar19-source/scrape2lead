import { GZ_PORTAL_ORIGIN } from "../goszakupOrigin.js";
import { marketMinUnitPrice } from "../market/config.js";
import {
  cleanBin,
  cleanHtmlText,
  extractAllTopLevelTables,
  extractAttribute,
  extractDocumentNodes,
  parseRuNumber,
  parseTableHtml,
  type ProtocolNode
} from "./htmlDom.js";
import type {
  AnnounceGeneralParsed,
  CalcBidRow,
  CompetitorBid,
  CompetitorGroup,
  CompetitorLot,
  CompetitorsConfig,
  CondDiscountBreakdown,
  DiscoveredLotRecord,
  LotDetailParsed,
  ParsedItogiLot,
  ProtocolLinkItem,
  SoftwareMention,
  SubpriceSubItem
} from "./types.js";

const MONOBLOCK_RE = /моноблок|all[\s\-]?in[\s\-]?one|\baio\b/i;
const KIT_RE = /комплект|кабинет|класс\b|учебн.*оборудован|интерактив.*комплекс/i;

const SOFTWARE_RULES: Array<{ category: string; name: string; pattern: RegExp }> = [
  { category: "OS", name: "Windows (Pro/Home/10/11)", pattern: /Windows\s*(?:10|11|Pro|Home|Enterprise|IoT|Server)?|Виндовс/i },
  { category: "OS", name: "Linux / Ubuntu / Astra / Alt", pattern: /\bAstra\s*Linux\b|\bAlt\s*Linux\b|\bUbuntu\b|\bDebian\b|\bLinux\b|\bRed\s*OS\b|\bРЕД\s*ОС\b/i },
  { category: "OS", name: "Android (встроенная ОС панели)", pattern: /\bAndroid\s*(?:\d+(?:\.\d+)?)?\b/i },
  { category: "OS", name: "macOS", pattern: /\bmacOS\b|\bMac\s*OS\b/i },
  { category: "Office", name: "Microsoft Office", pattern: /Microsoft\s*Office|MS\s*Office|Офисный пакет.*Microsoft|Office\s*(?:Home|Pro|Standard|LTSC|365|2019|2021|2024)/i },
  { category: "Office", name: "МойОфис / Р7-Офис", pattern: /Мой\s*Офис|MyOffice|Р7[\-\s]?Офис|R7[\-\s]?Office/i },
  { category: "Office", name: "LibreOffice / OpenOffice / WPS", pattern: /LibreOffice|OpenOffice|WPS\s*Office/i },
  { category: "Office", name: "Офисный пакет (общ.)", pattern: /офисн(?:ый|ого|ые)\s+пакет|офисн\w+\s+программ/i },
  { category: "Security", name: "Kaspersky / Dr.Web / ESET / Антивирус", pattern: /Kaspersky|Касперск|Dr\.?\s*Web|ESET|NOD32|антивирус\w*\s+ПО|антивирусн\w*\s+программ|вирусқа\s+қарсы/i },
  { category: "Interactive_SW", name: "MozaBook / Mozaik", pattern: /MozaBook|Mozaik|Мозабук/i },
  { category: "Interactive_SW", name: "Note / Bytello / EShare / ScreenShare", pattern: /\bBytello\b|\bEShare\b|\bBynote\b|Note\s*3|Note\s*5|Screen\s*Share|Whiteboard|доск\w*\s+ПО|интерактив\w*\s+ПО|программ\w*\s+(?:для\s+)?(?:белой\s+)?доск/i },
  { category: "Interactive_SW", name: "SMART Notebook / ActivInspire / ClassFlow / ViewBoard", pattern: /SMART\s*Notebook|ActivInspire|ClassFlow|myViewBoard|IdeaShare|Promethean/i },
  { category: "Interactive_SW", name: "Образовательные программы / 3D / предметное ПО", pattern: /виртуальн\w+\s+лаборатор|образовательн\w+\s+(?:ПО|программ|платформ|контент)|3D[\-\s]?(?:модел|атлас|визуализ)|Roqed|BilimLand|Daryn|Kundelik/i },
  { category: "Registry_RQC", name: "Упоминание Реестра доверенного ПО / КТРУ / НПА по ПО", pattern: /реестр\w*\s+доверен\w+\s+программ|доверен\w+\s+ПО|реестр\w*\s+отечествен\w+\s+ПО|сенімді\s+бағдарлама/i },
  { category: "Generic_SW", name: "Требование предустановленного ПО / лицензии", pattern: /предустановленн\w+\s+(?:ОС|ПО|операционн|программ)|лицензионн\w+\s+(?:ОС|ПО|программ|ключ)|операционн\w+\s+систем|бағдарламалық\s+қамтамасыз/i }
];

const MAC_EXPLICIT_RE =
  /(?:операционн\w*\s+систем\w*[^.\n;]{0,35}?\bmac\s*os\b|операциялық\s+жүйе(?:сі)?[^.\n;]{0,35}?\bmac\s*os\b|\bmac\s*os\s+(?:операциялық\s+жүйе|операционн|деңгейінен|sequoia|sonoma|ventura)|\b(?:MacBook|iMac)\b)/i;
const MAC_COMPAT_RE =
  /поддерж|совмест|драйвер|plug[\s\-]?and[\s\-]?play|қолдау|қолдайды|үйлесім|кроссплатформ|агент|universal\s+binary/i;
const PROPOSAL_CTX_RE =
  /предлагаем\w*|предложен\w*|заявлен\w*|поставляет\w*|указан[оаы]?\b.{0,45}(?:ос\b|по\b|операцион|windows|linux|macos|office|антивирус|марк|модел)|ұсынылған|көрсетілген|марка\s+microsoft|модель\s+windows|со\s+встроенным\s+антивирусом\s+[«"]/i;
const NEG_MISSING_CTX_RE =
  /(?:^|[.;:\n]\s*|\b)(?:не\s+указан|не\s+представлен|отсутству|не\s+приложен|не\s+подтвержд|не\s+выполнен|нет\s+подтвержд|көрсетілмеген|жоқ\b|ұсынылмаған)\b/i;

function normalizeSpaces(s: string): string {
  return s.replace(/""+/g, '"').replace(/\s+/g, " ").trim();
}

function absolutizePortalUrl(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `${GZ_PORTAL_ORIGIN}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

export function parseSearchLotsPage(html: string): { total: number; items: DiscoveredLotRecord[] } {
  const countMatch = html.match(/(?:Показано[^<]{0,80}из|из)\s+([\d\s]+)\s+запис/i);
  const total = countMatch ? Number(countMatch[1].replace(/\s+/g, "")) : 0;

  const tableMatch = html.match(/<table\b[^>]*\bid=["']search-result["'][^>]*>[\s\S]*?<\/table>/i);
  if (!tableMatch) return { total, items: [] };
  const table = parseTableHtml(tableMatch[0]);
  const items: DiscoveredLotRecord[] = [];

  for (const row of table.rows) {
    if (row.cells.length < 7 || row.cells.every((c) => c.isHeader)) continue;
    const lotNumber = row.cells[0].text;
    if (!lotNumber || lotNumber.toLowerCase().includes("не найдено")) continue;

    const c1Html = row.cells[1].html;
    const c1Text = row.cells[1].text;
    let annoUrl = "";
    for (const linkMatch of c1Html.matchAll(/<a\b([^>]*)>/gi)) {
      const href = extractAttribute(linkMatch[1], "href");
      if (href.includes("/announce/index/")) {
        annoUrl = absolutizePortalUrl(href);
        break;
      }
    }
    const annoId = annoUrl.match(/\/announce\/index\/(\d+)/)?.[1] ?? "";

    const strongMatch = c1Html.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
    const annoNumAndName = strongMatch ? cleanHtmlText(strongMatch[1]) : c1Text;
    const annoNumMatch = annoNumAndName.match(/^(\d+-\d+)\s+(.*)$/);
    const annoNumber = annoNumMatch ? annoNumMatch[1] : "";
    const annoName = annoNumMatch ? annoNumMatch[2] : annoNumAndName;

    const custMatch = c1Text.match(/Заказчик:\s*(.+)$/i);
    const customerNameSearch = custMatch ? custMatch[1].trim() : "";

    let lotUrl = "";
    for (const linkMatch of row.cells[2].html.matchAll(/<a\b([^>]*)>/gi)) {
      const href = extractAttribute(linkMatch[1], "href");
      if (/subpriceoffer|lots|announce/i.test(href)) {
        lotUrl = absolutizePortalUrl(href);
        break;
      }
    }
    const lotNameSearch = row.cells[2].text.replace(/\s+История$/i, "").trim();

    items.push({
      lotNumber,
      lotNameSearch,
      annoId,
      annoNumber,
      annoName,
      annoUrl,
      lotUrl,
      customerNameSearch,
      qtySearch: parseRuNumber(row.cells[3].text),
      plannedSumSearch: parseRuNumber(row.cells[4].text),
      methodSearch: row.cells[5].text,
      statusSearch: row.cells[6].text
    });
  }

  return { total: Number.isFinite(total) ? total : 0, items };
}

export function parseSubpriceoffer(html: string): LotDetailParsed {
  const tables = extractAllTopLevelTables(html);
  const kv: Record<string, string> = {};
  const subItems: SubpriceSubItem[] = [];

  for (const table of tables) {
    for (const row of table.rows) {
      if (row.cells.length === 2 && row.cells[0].text) {
        kv[row.cells[0].text] = row.cells[1].text;
      }
    }
    const firstRowText = table.rows[0]?.cells.map((c) => c.text) ?? [];
    if (firstRowText.some((h) => h.includes("Номер пункта плана"))) {
      for (const row of table.rows.slice(1)) {
        if (row.cells.length < 9) continue;
        subItems.push({
          planPoint: row.cells[1].text,
          customer: row.cells[2].text,
          name: row.cells[3].text,
          extraDesc: row.cells[4].text,
          unitPrice: parseRuNumber(row.cells[5].text),
          qty: parseRuNumber(row.cells[6].text),
          unit: row.cells[7].text,
          plannedSum: parseRuNumber(row.cells[8].text),
          status: row.cells[12]?.text ?? ""
        });
      }
    }
  }

  const rawLotNumber = (kv["Лот №"] ?? "").replace(/\s+История$/i, "").trim();
  const titleLotMatch = !rawLotNumber
    ? html.match(/<title\b[^>]*>[\s\S]*?(?:лоте?|лот)\s*№\s*([0-9A-Za-zА-Яа-яЁё\-]+)/i) ??
      html.match(/Информация\s+о\s+лоте\s*№\s*([0-9A-Za-zА-Яа-яЁё\-]+)/i)
    : null;
  const lotNumberPage = rawLotNumber || (titleLotMatch ? titleLotMatch[1].trim() : "");

  return {
    lotNumberPage,
    statusLot: kv["Статус лота"] ?? (subItems[0]?.status || ""),
    startDate: kv["Дата начала приема заявок"] ?? "",
    endDate: kv["Дата окончания приема заявок"] ?? "",
    customerBin: cleanBin(kv["БИН заказчика"]),
    customerName: normalizeSpaces(kv["Наименование заказчика"] ?? (subItems[0]?.customer || "")),
    enstruCodePage: kv["Код ТРУ"] ?? "",
    truName: kv["Наименование ТРУ"] ?? "",
    shortDesc: kv["Краткая характеристика"] ?? "",
    extraDesc: kv["Дополнительная характеристика"] ?? "",
    unitPrice: parseRuNumber(kv["Цена за единицу"]),
    unit: kv["Единица измерения"] ?? "",
    qty: parseRuNumber(kv["Количество"]),
    plannedSum:
      parseRuNumber(kv["Запланированная сумма"]) ??
      (subItems.length > 0 ? subItems.reduce((s, it) => s + (it.plannedSum ?? 0), 0) : null),
    deliveryKato: kv["Место поставки товара, КАТО"] ?? "",
    subItems
  };
}

export function parseAnnounceGeneral(html: string): AnnounceGeneralParsed {
  const tables = extractAllTopLevelTables(html);
  const kv: Record<string, string> = {};
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.cells.length === 2 && row.cells[0].text) {
        kv[row.cells[0].text] = row.cells[1].text;
      }
    }
  }

  const inputs: Record<string, string> = {};
  for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>[\s\S]{0,240}?value="([^"]*)"/gi)) {
    const label = cleanHtmlText(m[1]);
    if (label && !(label in inputs)) inputs[label] = m[2].trim();
  }

  const orgRaw = kv["Организатор"] ?? "";
  const orgMatch = orgRaw.match(/^(\d{12})\s+(.*)$/);

  return {
    annoNumberPage: inputs["Номер объявления"] ?? "",
    annoNamePage: inputs["Наименование объявления"] ?? "",
    annoStatus: inputs["Статус объявления"] ?? "",
    publishDate: inputs["Дата публикации объявления"] ?? "",
    startDate: inputs["Срок начала приема заявок"] ?? "",
    endDate: inputs["Срок окончания приема заявок"] ?? "",
    tradeMethod: kv["Способ проведения закупки"] ?? "",
    organizerBin: orgMatch ? orgMatch[1] : "",
    organizerName: orgMatch ? orgMatch[2].trim() : orgRaw,
    vatFlag: kv["Признаки"] ?? "",
    annoTotalSum: parseRuNumber(kv["Сумма закупки"])
  };
}

export function parseProtocolsTab(html: string): ProtocolLinkItem[] {
  const items: ProtocolLinkItem[] = [];
  // Track panel headings nearest to each download_file link
  const panelRegex = /<div\b[^>]*class=["'][^"']*panel\b[^"']*["'][^>]*>[\s\S]*?<div\b[^>]*class=["'][^"']*panel-heading[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  const panelHeadings: Array<{ index: number; text: string }> = [];
  for (const pm of html.matchAll(panelRegex)) {
    panelHeadings.push({ index: pm.index ?? 0, text: cleanHtmlText(pm[1]) });
  }

  const tables = extractAllTopLevelTables(html);
  for (const table of tables) {
    const headerRow = table.rows[0]?.cells.map((c) => c.text) ?? [];
    let heading = "";
    for (const ph of panelHeadings) {
      if (ph.index <= table.startIndex) heading = ph.text;
    }

    for (const row of table.rows) {
      const rowText = row.cells.map((c) => c.text).join(" ").trim();
      for (const cell of row.cells) {
        for (const aMatch of cell.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
          const href = extractAttribute(aMatch[1], "href");
          if (!href.includes("download_file")) continue;
          const linkText = cleanHtmlText(aMatch[2]);
          const linkLower = linkText.toLowerCase();
          const rowLower = rowText.toLowerCase();
          const headLower = heading.toLowerCase();

          let kind: ProtocolLinkItem["kind"] = "other";
          if (linkLower.includes("prot_pod_")) kind = "discussion";
          else if (headerRow.some((h) => h.includes("Протокол итогов")) || headLower.includes("итог")) kind = "itogi";
          else if (headLower.includes("вскрыт") || rowLower.includes("вскрыт")) kind = "vskrytie";
          else if (headLower.includes("допуск") || rowLower.includes("допуск")) kind = "dopusk";
          else if (linkText.includes("Просмотреть протокол")) kind = "protocol_other";

          let status = "";
          if (rowText.includes("Действительный")) status = "Действительный";
          else if (rowText.includes("Отменен") || rowText.includes("Недействительный")) status = "Отменен";

          items.push({
            url: absolutizePortalUrl(href),
            linkText,
            kind,
            status,
            heading,
            rowText: rowText.slice(0, 200)
          });
        }
      }
    }
  }

  return items;
}

export function extractFailureReason(conclusionText: string, numSubmitted: number, numAdmitted: number): string {
  const t = (conclusionText || "").toLowerCase();
  if (!t) {
    if (numSubmitted === 0) return "Отсутствие представленных заявок (по тексту таблиц)";
    if (numSubmitted === 1 && numAdmitted <= 1) return "Подана только 1 заявка";
    return "";
  }
  if (t.includes("отсутств") && t.includes("заявок")) return "Отсутствие представленных заявок";
  if (t.includes("менее двух") && (t.includes("подано") || t.includes("представлен"))) return "Подано менее двух заявок (1 или 0)";
  if (t.includes("допущен") && (t.includes("менее двух") || t.includes("один") || t.includes("только один"))) {
    return "Допущен только один поставщик (< 2)";
  }
  if (t.includes("отклонен") && t.includes("все")) return "Отклонены все заявки";
  if (t.includes("ни один") || t.includes("нет допущен") || (numAdmitted === 0 && numSubmitted > 0)) {
    return "Нет допущенных поставщиков";
  }
  if (numSubmitted === 0) return "Отсутствие представленных заявок";
  if (numSubmitted === 1) return "Подана только 1 заявка";
  if (numAdmitted === 1) return "Допущен только один поставщик (< 2)";
  return normalizeSpaces(conclusionText).slice(0, 160);
}

/**
 * Parses the Russian section of an HTML «Протокол об итогах».
 */
export function parseItogiHtml(html: string, targetLotNumbers: ReadonlySet<string> = new Set()): Record<string, ParsedItogiLot> {
  const docNodes = extractDocumentNodes(html);
  const ruNodes: ProtocolNode[] = [];
  let startedRu = false;

  for (const node of docNodes) {
    if (node.kind === "table") {
      const hdr = node.headerText;
      if (
        !startedRu &&
        (hdr.includes("Ф. И. О. (при его наличии)") ||
          hdr.includes("№ лота") ||
          hdr.includes("Наименование потенциального поставщика") ||
          hdr.includes("Выделенная сумма"))
      ) {
        startedRu = true;
      }
      if (startedRu) ruNodes.push(node);
    } else if (startedRu) {
      ruNodes.push(node);
    }
  }

  const lotsTableMeta: Record<string, ParsedItogiLot["lotMeta"]> = {};
  for (const node of ruNodes) {
    if (node.kind === "table" && node.headerText.includes("№ лота") && node.headerText.includes("Наименование лота")) {
      for (const row of node.table.rows.slice(1)) {
        const cols = row.cells.map((c) => c.text);
        if (cols.length >= 6) {
          const ln = cols[1];
          lotsTableMeta[ln] = {
            lotName: cols[2],
            qty: parseRuNumber(cols[3]),
            unitPrice: parseRuNumber(cols[4]),
            plannedSum: parseRuNumber(cols[5])
          };
        }
      }
      break;
    }
  }

  const knownLots = [...new Set([...targetLotNumbers, ...Object.keys(lotsTableMeta)])];
  const matchKnownLot = (candidateStr: string): string => {
    const firstTok = (candidateStr.split(/\s+/)[0] ?? "").replace(/^[\s,.;:]+|[\s,.;:]+$/g, "");
    for (const ln of knownLots) {
      if (ln === firstTok || ln.replace(/\s+/g, "") === firstTok.replace(/\s+/g, "")) return ln;
    }
    for (const ln of knownLots) {
      if (candidateStr.startsWith(ln)) return ln;
    }
    return firstTok;
  };

  const lotSegments = new Map<string, ProtocolNode[]>();
  const preLotNodes: ProtocolNode[] = [];
  let currentLot: string | null = null;
  const lotMarkerRe = /№\s*лота\s+([0-9A-Za-zА-Яа-яЁё\-]+(?:\s+[^\s]+)?)/i;

  for (const node of ruNodes) {
    if (node.kind === "table") {
      const hdr = node.headerText;
      if (hdr.includes("№ лота") && hdr.includes("Наименование лота")) continue;
      if (hdr.includes("Должность в организации")) continue;
    } else {
      const m = node.text.match(lotMarkerRe);
      if (
        m &&
        m.index !== undefined &&
        (node.text.includes("Наименование лота") || node.text.startsWith("№ лота") || node.text.includes("По лоту №")) &&
        !node.text.toLowerCase().startsWith("признать ")
      ) {
        const afterMarker = node.text.slice(m.index + m[0].indexOf(m[1]));
        currentLot = matchKnownLot(afterMarker);
        const list = lotSegments.get(currentLot) ?? [];
        list.push(node);
        lotSegments.set(currentLot, list);
        continue;
      }
    }

    if (currentLot === null) preLotNodes.push(node);
    else {
      const list = lotSegments.get(currentLot) ?? [];
      list.push(node);
      lotSegments.set(currentLot, list);
    }
  }

  if (lotSegments.size === 0 && preLotNodes.length > 0) {
    const metaKeys = Object.keys(lotsTableMeta);
    if (metaKeys.length === 1) lotSegments.set(metaKeys[0], preLotNodes);
    else if (targetLotNumbers.size === 1) lotSegments.set([...targetLotNumbers][0], preLotNodes);
  }

  const parsedLots: Record<string, ParsedItogiLot> = {};

  for (const [ln, nodes] of lotSegments.entries()) {
    const submitted: ParsedItogiLot["submitted"] = {};
    const votingRejRaw: Record<string, { short: Set<string>; detail: string[] }> = {};
    const rejTable: Record<string, string> = {};
    const admittedBins = new Set<string>();
    const condDisc: ParsedItogiLot["condDisc"] = {};
    const calcRows: CalcBidRow[] = [];
    let winner: ParsedItogiLot["winner"] = null;
    let second: ParsedItogiLot["second"] = null;
    const conclusions: string[] = [];

    for (const node of nodes) {
      if (node.kind === "text") {
        const lower = node.text.toLowerCase();
        if (["признать", "несостояв", "победител", "второе место", "договор", "отменен"].some((k) => lower.includes(k))) {
          conclusions.push(node.text);
        }
        continue;
      }

      const hdr = node.headerText;
      const trs = node.table.rows;

      if (hdr.includes("Выделенная сумма") && hdr.includes("Цена поставщика")) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length >= 8 ? cleanBin(cols[2]) : "";
          if (bin && cols[1] !== "2") {
            calcRows.push({
              rank: /^\d+$/.test(cols[0]) ? Number(cols[0]) : null,
              name: cols[1],
              bin,
              allocSum: parseRuNumber(cols[3]),
              supplierPriceRaw: parseRuNumber(cols[4]),
              art13Sum: parseRuNumber(cols[5]),
              condDiscPct: parseRuNumber(cols[6]) ?? 0,
              condPrice: parseRuNumber(cols[7]),
              submitDt: cols[11] ?? ""
            });
          }
        }
      } else if (hdr.includes("Дата и время") && (hdr.includes("представления") || hdr.includes("хронологии"))) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length >= 4 ? cleanBin(cols[2]) : "";
          if (bin) submitted[bin] = { name: cols[1], bin, submitDt: cols[3] };
        }
      } else if (hdr.includes("№ п/п") && hdr.includes("Наименование потенциального")) {
        let curBin = "";
        let idxDec = 3;
        let idxShort = 4;
        let idxDet = 5;
        let dataStartIdx = 1;
        if (trs.length > 1) {
          const subh = trs[1].cells.map((c) => c.text.toLowerCase());
          const hasSubheader = subh.some(
            (colH) => colH.includes("решение") || colH.startsWith("причина") || colH.includes("подробн")
          );
          const headerCols = trs[0].cells.map((c) => c.text.toLowerCase());
          const targetHdr = hasSubheader ? subh : headerCols;
          if (hasSubheader) dataStartIdx = 2;
          targetHdr.forEach((colH, ci) => {
            if (colH.includes("решение")) idxDec = ci;
            else if (colH.startsWith("причина")) idxShort = ci;
            else if (colH.includes("подробн") || colH.includes("описание")) idxDet = ci;
          });
        }
        for (const row of trs.slice(dataStartIdx)) {
          const cols = row.cells.map((c) => c.text);
          if (cols.length === 2 && cols[1]) {
            const m = cols[1].match(/(\d{12})/);
            curBin = m ? m[1] : "";
          } else if (cols.length > Math.max(idxDec, idxShort) && curBin) {
            const dec = cols[idxDec];
            const shortR = cols[idxShort];
            const detR = cols.length > idxDet ? cols[idxDet] : "";
            if (dec.toLowerCase().includes("отклон") || shortR) {
              const entry = (votingRejRaw[curBin] ??= { short: new Set<string>(), detail: [] });
              if (shortR) entry.short.add(shortR);
              if (detR && !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(detR) && !entry.detail.includes(detR)) {
                entry.detail.push(detR);
              }
            }
          }
        }
      } else if (hdr.includes("Причина отклонения 1")) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length >= 4 ? cleanBin(cols[2]) : "";
          if (bin) {
            const reasons = cols.slice(3).filter(Boolean);
            if (reasons.length > 0) rejTable[bin] = reasons.join(" | ");
          }
        }
      } else if (trs[0]?.cells.length === 3 && hdr.includes("БИН") && !hdr.toLowerCase().includes("второе место")) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length === 3 ? cleanBin(cols[2]) : "";
          if (bin) admittedBins.add(bin);
        }
      } else if (hdr.includes("Условные скидки")) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length === 14 ? cleanBin(cols[2]) : "";
          if (bin && /^\d+$/.test(cols[0])) {
            condDisc[bin] = {
              taxPct: parseRuNumber(cols[3]),
              funcPct: parseRuNumber(cols[4]),
              techPct: parseRuNumber(cols[5]),
              qualPct: parseRuNumber(cols[6]),
              operPct: parseRuNumber(cols[7]),
              localPct: parseRuNumber(cols[8]),
              auditPct: parseRuNumber(cols[9]),
              negContractsPct: parseRuNumber(cols[10]),
              negRnuPct: parseRuNumber(cols[11]),
              otpKtpPct: parseRuNumber(cols[12]),
              totalDiscPct: parseRuNumber(cols[13])
            };
          }
        }
      } else if (hdr.includes("бенефициарного владельца") && hdr.includes("Наименование потенциального поставщика")) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length >= 4 ? cleanBin(cols[2]) : "";
          if (bin && /^\d+$/.test(cols[0])) {
            winner = { name: cols[1], bin, beneficiary: cols[3] };
          }
        }
      } else if (hdr.includes("занявшего второе место")) {
        for (const row of trs.slice(1)) {
          const cols = row.cells.map((c) => c.text);
          const bin = cols.length >= 3 ? cleanBin(cols[2]) : "";
          if (bin && /^\d+$/.test(cols[0])) {
            second = { name: cols[1], bin };
          }
        }
      }
    }

    const votingRej: ParsedItogiLot["votingRej"] = {};
    for (const [k, v] of Object.entries(votingRejRaw)) {
      votingRej[k] = { short: [...v.short].sort(), detail: v.detail.join(" || ") };
    }

    parsedLots[ln] = {
      lotMeta: lotsTableMeta[ln] ?? {},
      submitted,
      votingRej,
      rejTable,
      admittedBins: [...admittedBins].sort(),
      condDisc,
      calcRows,
      winner,
      second,
      conclusions: conclusions.join(" | ")
    };
  }

  return parsedLots;
}

export function extractDiagonal(text: string, kind: string): string {
  if (!text) return "";
  const counts = new Map<number, number>();
  const re =
    /(?:диагонал[ьи]|размер\s+экрана|экрана?|panel|панел[ьи]|монитор)\D{0,25}?(\d{2,3})(?:[.,]\d)?\s*(?:"|”|″|''|дюйм|inch)|(\d{2,3})(?:[.,]\d)?\s*(?:"|”|″|''|дюйм|inch)/gi;
  const panelSizes = new Set([55, 65, 70, 75, 82, 84, 85, 86, 92, 98, 100, 105, 110]);

  for (const m of text.matchAll(re)) {
    const val = Number(m[1] || m[2]);
    if (kind === "Интерактивная панель" || kind === "Интерактивная доска" || kind === "Учебный комплект") {
      if (panelSizes.has(val)) counts.set(val, (counts.get(val) ?? 0) + 1);
    } else if (val >= 13 && val <= 49) {
      counts.set(val, (counts.get(val) ?? 0) + 1);
    }
  }

  if (counts.size > 0) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return `${top}"`;
  }

  const m2 = text.match(/\b(55|65|75|86|98|100|105|110)[\s\-]?дюйм/i);
  return m2 ? `${m2[1]}"` : "";
}

export function extractCpu(text: string): string {
  if (!text) return "";
  const checks: Array<[string, RegExp]> = [
    ["Core Ultra 9", /Core\s*Ultra\s*9/i],
    ["Core Ultra 7", /Core\s*Ultra\s*7/i],
    ["Core Ultra 5", /Core\s*Ultra\s*5/i],
    ["Core i9", /Core\s*i[\-\s]?9|\bi9[\-\s]?\d{4,5}/i],
    ["Core i7", /Core\s*i[\-\s]?7|\bi7[\-\s]?\d{4,5}/i],
    ["Core i5", /Core\s*i[\-\s]?5|\bi5[\-\s]?\d{4,5}/i],
    ["Core i3", /Core\s*i[\-\s]?3|\bi3[\-\s]?\d{4,5}/i],
    ["Ryzen 9", /Ryzen\s*9/i],
    ["Ryzen 7", /Ryzen\s*7/i],
    ["Ryzen 5", /Ryzen\s*5/i],
    ["Ryzen 3", /Ryzen\s*3/i],
    ["Intel N100/N200/N95", /\bN(?:95|97|100|150|200|305)\b/i],
    ["Celeron/Pentium/Athlon", /Celeron|Pentium|Athlon/i],
    ["Apple M-series", /Apple\s*M[1-4]/i],
    ["Xeon", /\bXeon\b/i]
  ];
  const found = checks.filter(([, re]) => re.test(text)).map(([label]) => label);
  if (found.length === 0) return "";
  return found.slice(0, 2).join(" / ");
}

export function extractSoftwareMentions(
  text: string,
  source: SoftwareMention["source"],
  isRejection = false
): SoftwareMention[] {
  if (!text) return [];
  const out: SoftwareMention[] = [];

  for (const rule of SOFTWARE_RULES) {
    const m = text.match(rule.pattern);
    if (!m || m.index === undefined) continue;
    const start = Math.max(0, m.index - 80);
    const end = Math.min(text.length, m.index + m[0].length + 100);
    const ctx = text.slice(start, end);

    if (rule.name === "macOS") {
      if (MAC_COMPAT_RE.test(ctx) || !MAC_EXPLICIT_RE.test(ctx)) continue;
    }

    let rowSource = source;
    if (isRejection) {
      const localPre = text.slice(Math.max(0, m.index - 65), m.index);
      const hasProp = PROPOSAL_CTX_RE.test(ctx);
      const hasNegPre = NEG_MISSING_CTX_RE.test(localPre);
      if (["OS", "Office", "Security", "Interactive_SW"].includes(rule.category) && hasProp && !hasNegPre) {
        rowSource = "предложил участник";
      } else {
        rowSource = "не предоставил (причина отклонения)";
      }
    }

    out.push({
      source: rowSource,
      category: rule.category,
      software: rule.name,
      matchedToken: normalizeSpaces(m[0]),
      evidence: normalizeSpaces(ctx).slice(0, 220)
    });
  }

  return out;
}

export interface ClassifyCompetitorInput {
  enstruCodes: string[];
  lotNumber: string;
  titleText: string;
  unitPrice: number | null;
  plannedSum: number | null;
  qty: number | null;
  subItemsCount?: number;
}

export interface ClassifyCompetitorResult {
  include: boolean;
  group: CompetitorGroup | "";
  kind: string;
  isCombinedLot: boolean;
  isKit: boolean;
  diagonal: string;
  cpu: string;
}

export function classifyCompetitorLot(
  input: ClassifyCompetitorInput,
  specText: string,
  cfg: CompetitorsConfig
): ClassifyCompetitorResult {
  const hidden = new Set(cfg.market.hiddenKinds ?? []);
  const codes = input.enstruCodes.filter(Boolean);
  const fullText = `${input.titleText}\n${specText || ""}`;
  const isCombinedLot = input.lotNumber.includes("-ОЛ-") || (input.subItemsCount ?? 0) > 1;
  const qty = input.qty && input.qty > 0 ? input.qty : 1;
  const unitPrice = input.unitPrice ?? (input.plannedSum !== null ? input.plannedSum / qty : null);

  // Exclude hidden kinds (e.g. Мультимедийные системы) unless another active code matched
  const nonHiddenCodes = codes.filter((c) => {
    for (const grp of [cfg.market.groups["ИП"], cfg.market.groups["КТ"]]) {
      for (const k of grp.kinds) {
        if (k.patterns.some((p) => new RegExp(p).test(c))) {
          return !hidden.has(k.name);
        }
      }
    }
    return false;
  });

  if (nonHiddenCodes.length === 0) {
    return { include: false, group: "", kind: "", isCombinedLot, isKit: false, diagonal: "", cpu: "" };
  }

  // 279020.100.* filter: MUST contain интерактив / interactive if no other code matched
  const hasInteractiveKw = /интерактив|interactive/i.test(fullText);
  const non279Codes = nonHiddenCodes.filter((c) => !c.startsWith("279020.100."));
  if (non279Codes.length === 0 && !hasInteractiveKw) {
    return { include: false, group: "", kind: "", isCombinedLot, isKit: false, diagonal: "", cpu: "" };
  }

  // Determine group & kind
  const kindForCode = (code: string): { group: CompetitorGroup | ""; kind: string } => {
    if (code === "262030.100.000021" || (code.startsWith("279020.100.") && hasInteractiveKw)) {
      return { group: "ИП", kind: "Интерактивная панель" };
    }
    if (code === "262030.100.000043") return { group: "ИП", kind: "Интерактивная доска" };
    if (code === "329959.900.000019") return { group: "ИП", kind: "Учебный комплект" };
    if (code.startsWith("262013.000.")) {
      return { group: "КТ", kind: MONOBLOCK_RE.test(input.titleText) ? "Моноблок" : "Компьютер" };
    }
    if (code.startsWith("262040.000.")) return { group: "КТ", kind: "Системный блок" };
    if (code.startsWith("262011.100.")) return { group: "КТ", kind: "Ноутбук" };
    if (code.startsWith("262018.900.")) return { group: "КТ", kind: "МФУ" };
    if (code.startsWith("262016.300.")) return { group: "КТ", kind: "Принтер" };
    if (code.startsWith("262017.100.")) return { group: "КТ", kind: "Монитор" };
    return { group: "", kind: "" };
  };

  let group: CompetitorGroup | "" = "";
  let kind = "";
  let matchedCode = nonHiddenCodes[0];
  for (const c of nonHiddenCodes) {
    const res = kindForCode(c);
    if (res.group) {
      group = res.group;
      kind = res.kind;
      matchedCode = c;
      break;
    }
  }
  if (!group) {
    return { include: false, group: "", kind: "", isCombinedLot, isKit: false, diagonal: "", cpu: "" };
  }

  const minPrice = marketMinUnitPrice(matchedCode, cfg.market);
  if (!isCombinedLot && unitPrice !== null && unitPrice < minPrice) {
    return { include: false, group: "", kind: "", isCombinedLot, isKit: false, diagonal: "", cpu: "" };
  }

  const isKit = kind === "Учебный комплект" || KIT_RE.test(input.titleText);
  const diagonal = extractDiagonal(fullText, kind);
  const cpu = group === "КТ" ? extractCpu(fullText) : "";

  return { include: true, group, kind, isCombinedLot, isKit, diagonal, cpu };
}

/**
 * Marks `annoId:lotNumber` -> true for the single latest announcement version of each unique lotNumber.
 * Demotes `Изменена документация` below active/finished announcements; then sorts by `(startDate, Number(annoId))`.
 */
export function dedupeLatestLotVersions<T extends { annoId: string; lotNumber: string; status: string; startDate: string }>(
  lots: readonly T[]
): Map<string, boolean> {
  const byLot = new Map<string, T[]>();
  for (const lot of lots) {
    const arr = byLot.get(lot.lotNumber) ?? [];
    arr.push(lot);
    byLot.set(lot.lotNumber, arr);
  }

  const out = new Map<string, boolean>();
  for (const [, versions] of byLot) {
    let best = versions[0];
    for (const candidate of versions.slice(1)) {
      if (compareVersion(candidate, best) > 0) best = candidate;
    }
    for (const v of versions) {
      out.set(`${v.annoId}:${v.lotNumber}`, v.annoId === best.annoId && v.lotNumber === best.lotNumber);
    }
  }
  return out;
}

function compareVersion(
  a: { annoId: string; status: string; startDate: string },
  b: { annoId: string; status: string; startDate: string }
): number {
  const aNotAmended = a.status !== "Изменена документация" ? 1 : 0;
  const bNotAmended = b.status !== "Изменена документация" ? 1 : 0;
  if (aNotAmended !== bNotAmended) return aNotAmended - bNotAmended;
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  return Number(a.annoId) - Number(b.annoId);
}

export interface NormalizeLotInput {
  annoId: string;
  annoNumber: string;
  annoName: string;
  lotNumber: string;
  lotName: string;
  enstruCode: string;
  group: CompetitorGroup;
  kind: string;
  diagonal: string;
  cpu: string;
  isCombinedLot: boolean;
  isKit: boolean;
  status: string;
  startDate: string;
  endDate: string;
  customerBin: string;
  customerName: string;
  qty: number;
  plannedUnitPriceNoVat: number | null;
  plannedSumNoVat: number | null;
  hasTechspec: boolean;
  techspecUrl: string;
  protocolUrl: string;
  parsedItogi: ParsedItogiLot | null;
  cfg: CompetitorsConfig;
}

export function normalizeCompetitorLotAndBids(input: NormalizeLotInput): { lot: CompetitorLot; bids: CompetitorBid[] } {
  const { parsedItogi, cfg, qty, plannedUnitPriceNoVat: up, plannedSumNoVat: ps, isCombinedLot } = input;
  const ourLabel = (bin: string) => (bin && cfg.allOurBins.has(bin) ? cfg.ourCompanyNames[bin] || bin : "");
  const bids: CompetitorBid[] = [];

  let winnerBin = "";
  let winnerName = "";
  let secondBin = "";
  let secondName = "";
  let failureReason = "";
  let numSubmitted = 0;
  let numAdmitted = 0;
  let winnerBidUnitPriceNoVat: number | null = null;
  let winnerBidTotalPriceNoVat: number | null = null;
  let winnerDiscountFromPlanPct: number | null = null;
  let winnerCondDiscountPct: number | null = null;

  if (parsedItogi) {
    const sub = parsedItogi.submitted;
    const adm = new Set(parsedItogi.admittedBins);
    const cond = parsedItogi.condDisc;
    const calc = parsedItogi.calcRows;
    const vrej = parsedItogi.votingRej;
    const rtab = parsedItogi.rejTable;
    const win = parsedItogi.winner;
    const sec = parsedItogi.second;

    const allBins: string[] = [];
    const seen = new Set<string>();
    for (const row of calc) {
      if (row.bin && !seen.has(row.bin)) {
        seen.add(row.bin);
        allBins.push(row.bin);
      }
    }
    for (const b of [...Object.keys(sub), ...adm, ...Object.keys(cond), ...Object.keys(vrej), ...Object.keys(rtab)]) {
      if (b && !seen.has(b)) {
        seen.add(b);
        allBins.push(b);
      }
    }

    const rankedCalc = calc.filter((r) => r.rank !== null);
    const calcByBin = new Map(calc.map((c) => [c.bin, c]));

    if (win) {
      winnerBin = win.bin;
      winnerName = win.name;
    } else if (input.status === "Закупка состоялась" && rankedCalc.length > 0) {
      const r1 = rankedCalc.find((x) => x.rank === 1) ?? rankedCalc[0];
      winnerBin = r1.bin;
      winnerName = r1.name;
    }

    if (sec) {
      secondBin = sec.bin;
      secondName = sec.name;
    } else if (input.status === "Закупка состоялась" && rankedCalc.length >= 2) {
      const r2 = rankedCalc.find((x) => x.rank === 2) ?? rankedCalc[1];
      secondBin = r2.bin;
      secondName = r2.name;
    }

    numSubmitted = Math.max(Object.keys(sub).length, allBins.length);
    numAdmitted = Math.max(adm.size, rankedCalc.length);

    if (input.status !== "Закупка состоялась") {
      failureReason = extractFailureReason(parsedItogi.conclusions, numSubmitted, numAdmitted);
    }

    for (const b of allBins) {
      const c = calcByBin.get(b);
      const sInfo = sub[b];
      const cd = cond[b];
      const vr = vrej[b];
      const shortRej = rtab[b] || (vr?.short.join(", ") ?? "");
      const detRej = vr?.detail ?? "";
      const bName = (c?.name || sInfo?.name || "").trim();

      let admStatus: CompetitorBid["admittedStatus"];
      if (adm.has(b) || (c !== undefined && c.rank !== null) || b === winnerBin) {
        admStatus = "Допущен";
      } else if (shortRej || detRej || b in vrej || b in rtab || (c !== undefined && c.rank === null)) {
        admStatus = "Отклонен";
      } else {
        admStatus = "Не допущен/не рассмотрен";
      }

      let unitPrice: number | null = null;
      let totalPrice: number | null = null;
      let condPrice: number | null = null;
      let condDiscPct: number | null = cd?.totalDiscPct ?? null;

      if (c) {
        const rawP = c.supplierPriceRaw;
        const cp = c.condPrice;
        const dPct = c.condDiscPct;
        condDiscPct = dPct ?? condDiscPct;
        condPrice = cp;
        const factor = 1 - (dPct || 0) / 100;

        if (isCombinedLot && cp !== null) {
          totalPrice = factor > 0 ? Math.round((cp / factor) * 100) / 100 : cp;
          unitPrice = null;
        } else if (rawP !== null && cp !== null && qty > 0) {
          const tol = Math.max(5, cp * 0.002);
          const expIfUnit = qty * rawP * factor;
          const expIfTotal = rawP * factor;
          if (qty === 1) {
            unitPrice = rawP;
            totalPrice = rawP;
          } else if (Math.abs(expIfUnit - cp) <= tol) {
            unitPrice = rawP;
            totalPrice = Math.round(rawP * qty * 100) / 100;
          } else if (Math.abs(expIfTotal - cp) <= tol) {
            totalPrice = rawP;
            unitPrice = Math.round((rawP / qty) * 100) / 100;
          } else if (up && Math.abs(rawP - up) <= Math.abs(rawP - (ps ?? up * qty))) {
            unitPrice = rawP;
            totalPrice = Math.round(rawP * qty * 100) / 100;
          } else {
            totalPrice = rawP;
            unitPrice = Math.round((rawP / qty) * 100) / 100;
          }
        }
      }

      let discountFromPlanPct: number | null = null;
      if (unitPrice !== null && up && up > 0) {
        discountFromPlanPct = Math.round(((up - unitPrice) / up) * 10000) / 100;
      } else if (totalPrice !== null && ps && ps > 0) {
        discountFromPlanPct = Math.round(((ps - totalPrice) / ps) * 10000) / 100;
      }

      const isWinner = b === winnerBin && input.status === "Закупка состоялась";
      const isSecondPlace = b === secondBin && input.status === "Закупка состоялась";

      if (isWinner) {
        winnerBidUnitPriceNoVat = unitPrice;
        winnerBidTotalPriceNoVat = totalPrice;
        winnerDiscountFromPlanPct = discountFromPlanPct;
        winnerCondDiscountPct = condDiscPct;
      }

      bids.push({
        annoId: input.annoId,
        lotNumber: input.lotNumber,
        isLatestLotVersion: true,
        group: input.group,
        kind: input.kind,
        diagonal: input.diagonal,
        cpu: input.cpu,
        isCombinedLot,
        isKit: input.isKit,
        startDate: input.startDate,
        lotStatus: input.status,
        plannedQty: qty,
        plannedUnitPriceNoVat: up,
        plannedSumNoVat: ps,
        bidderBin: b,
        bidderName: bName,
        ourCompany: ourLabel(b),
        admittedStatus: admStatus,
        rejectionShort: shortRej,
        rejectionDetail: detRej.slice(0, 600),
        bidUnitPriceNoVat: unitPrice,
        bidTotalPriceNoVat: totalPrice,
        discountFromPlanPct,
        condDiscountPct: condDiscPct,
        otpKtpPct: cd?.otpKtpPct ?? 0,
        condPriceNoVat: condPrice,
        isWinner,
        isSecondPlace
      });
    }
  }

  const lot: CompetitorLot = {
    annoId: input.annoId,
    annoNumber: input.annoNumber,
    annoName: input.annoName,
    lotNumber: input.lotNumber,
    lotName: input.lotName,
    enstruCode: input.enstruCode,
    group: input.group,
    kind: input.kind,
    diagonal: input.diagonal,
    cpu: input.cpu,
    isCombinedLot,
    isKit: input.isKit,
    isLatestVersion: true,
    status: input.status,
    startDate: input.startDate,
    endDate: input.endDate,
    customerBin: input.customerBin,
    customerName: input.customerName,
    qty,
    plannedUnitPriceNoVat: up,
    plannedSumNoVat: ps,
    numSubmitted,
    numAdmitted,
    winnerBin,
    winnerName,
    winnerIsOurs: ourLabel(winnerBin),
    winnerBidUnitPriceNoVat,
    winnerBidTotalPriceNoVat,
    winnerDiscountFromPlanPct,
    winnerCondDiscountPct,
    secondBin,
    secondName,
    failureReason,
    lotUrl: `${GZ_PORTAL_ORIGIN}/ru/announce/index/${input.annoId}`,
    annoUrl: `${GZ_PORTAL_ORIGIN}/ru/announce/index/${input.annoId}`,
    protocolUrl: input.protocolUrl,
    techspecUrl: input.techspecUrl,
    hasTechspec: input.hasTechspec,
    hasItogi: Boolean(parsedItogi)
  };

  return { lot, bids };
}
