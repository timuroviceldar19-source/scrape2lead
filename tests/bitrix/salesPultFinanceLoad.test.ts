import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FINANCE_PARSE_VERSION, loadFinanceView } from "../../src/bitrix/salesPult/finance/load.js";
import { decryptPayload, encryptPayload } from "../../src/bitrix/salesPult/register/crypto.js";
import ExcelJS from "exceljs";
import { financeWorkbookBuffer } from "../fixtures/sales-pult/financeWorkbook.js";
import { incomeStatementWorkbookBuffer } from "../fixtures/sales-pult/incomeStatementWorkbook.js";

// Все данные выдуманные. Папка чата и скачивание файлов подменены.

let good: Buffer;
let shifted: Buffer;
let fo: Buffer;
let foBroken: Buffer;
beforeAll(async () => {
  good = await financeWorkbookBuffer();
  fo = await incomeStatementWorkbookBuffer();
  // книга ФО, у которой на листе «ОПиУ» пропала шапка с месяцами
  const broken = new ExcelJS.Workbook();
  broken.addWorksheet("ОПиУ").getCell("B2").value = "Отчет о прибылях и убытках";
  broken.addWorksheet("Расш. ОПиУ");
  foBroken = Buffer.from(await broken.xlsx.writeBuffer());
  shifted = await financeWorkbookBuffer({
    debtors: [{ name: "Школа Тест №1", company: 0, amount: 1_000_000, date: "2026-11-05" }]
  });
});

const KEY = "test-finance-key";

function file(id: number, created: string, extra: Record<string, unknown> = {}) {
  return { ID: id, NAME: `Ежедневный отчет${id > 1 ? ` (${id - 1})` : ""}.xlsx`, TYPE: "file", CREATE_TIME: created, UPDATE_TIME: created, DOWNLOAD_URL: `https://disk.example.test/${id}`, ...extra };
}

function setup(listing: Array<Record<string, unknown>>, bodies: Record<string, Buffer | number>) {
  const asked: string[] = [];
  const reader = { listAllBatched: vi.fn(async () => listing as never[]) };
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    const key = String(url);
    asked.push(key);
    const body = bodies[key];
    if (typeof body === "number") return new Response("x", { status: body });
    if (!body) throw new TypeError("fetch failed");
    return new Response(new Uint8Array(body));
  }) as unknown as typeof fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fin-"));
  return { reader, fetchFn, asked, cachePath: path.join(dir, "finance.json") };
}

const logs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  logs.length = 0;
});
function captureLogs() {
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void logs.push(a.join(" ")));
}

describe("финансы: загрузка из папки чата", () => {
  it("берёт самый свежий .xlsx по времени загрузки, остальные файлы идут в историю", async () => {
    captureLogs();
    const listing = [
      file(1, "2026-11-16T10:00:00+03:00"),
      file(2, "2026-11-17T10:00:00+03:00"),
      { ID: 9, NAME: "фото.jpg", TYPE: "file", CREATE_TIME: "2026-11-18T10:00:00+03:00", DOWNLOAD_URL: "https://disk.example.test/9" }
    ];
    const s = setup(listing, { "https://disk.example.test/1": shifted, "https://disk.example.test/2": good });
    const view = await loadFinanceView({ reader: s.reader, folderId: 104393, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(s.reader.listAllBatched).toHaveBeenCalledWith("disk.folder.getchildren", { id: 104393 });
    expect(view.file).toEqual({ id: "2", name: "Ежедневный отчет (1).xlsx", uploadedAt: "2026-11-17T10:00:00+03:00" });
    expect(view.report?.debtors.total).toBe(10_000_000);
    expect(view.error).toBeUndefined();
    expect(view.notice).toBeUndefined();
    // оба файла за одну дату данных: в истории остаётся более поздний
    expect(view.snapshots.map((x) => [x.dataDate, x.debtors])).toEqual([["2026-11-16", 10_000_000]]);
    expect(s.asked).not.toContain("https://disk.example.test/9");
    // лог публичный: ни сумм, ни названий из файла
    const log = logs.join("\n");
    expect(log).toMatch(/Файлов в чате: 2, разобрано сейчас: 2, отчёт на 2026-11-16/);
    expect(log).not.toMatch(/Альфа|Банк|Школа|000 000|1000000/);
  });

  it("кэш зашифрован; на следующем запуске файлы не скачиваются заново", async () => {
    const listing = [file(1, "2026-11-17T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": good });
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    const raw = fs.readFileSync(s.cachePath, "utf8");
    expect(JSON.parse(raw).alg).toBe("aes-256-gcm");
    expect(raw).not.toMatch(/Альфа|Школа/);
    const again = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(s.asked).toHaveLength(1);
    expect(again.report?.dataDate).toBe("2026-11-16");
    // чужой ключ — кэш не читается, история собирается из папки заново
    const other = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: "other", fetchFn: s.fetchFn });
    expect(other.report?.dataDate).toBe("2026-11-16");
    expect(s.asked).toHaveLength(2);
  });

  it("новый файл не разобрался — показан прошлый отчёт и пояснение", async () => {
    const listing = [file(1, "2026-11-16T10:00:00+03:00"), file(2, "2026-11-17T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": good, "https://disk.example.test/2": Buffer.from("not xlsx") });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.file?.id).toBe("1");
    expect(view.notice).toBe("Последний файл «Ежедневный отчет (1).xlsx» (17.11 12:00) не разобран: файл не читается как .xlsx. Показан отчёт из файла «Ежедневный отчет.xlsx» (16.11 12:00).");
    // битый файл не скачивается на каждом запуске
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(s.asked.filter((u) => u.endsWith("/2"))).toHaveLength(1);
  });

  it("после смены версии разбора файл, который раньше не разобрался, разбирается заново", async () => {
    const listing = [file(1, "2026-11-16T10:00:00+03:00"), file(2, "2026-11-17T10:00:00+03:00")];
    const bodies: Record<string, Buffer | number> = { "https://disk.example.test/1": good, "https://disk.example.test/2": Buffer.from("not xlsx") };
    const s = setup(listing, bodies);
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    // кэш от прошлой версии разбора, а файл теперь читается (как файл 18.11 со скрытыми колонками)
    const cache = JSON.parse(decryptPayload(fs.readFileSync(s.cachePath, "utf8"), KEY));
    expect(cache.v).toBe(FINANCE_PARSE_VERSION);
    expect(cache.files["2"].ok).toBe(false);
    fs.writeFileSync(s.cachePath, encryptPayload(JSON.stringify({ ...cache, v: FINANCE_PARSE_VERSION - 1 }), KEY), "utf8");
    bodies["https://disk.example.test/2"] = await financeWorkbookBuffer({ cashGap: true, stockSheets: true });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.file?.id).toBe("2");
    expect(view.notice).toBeUndefined();
    expect(view.report?.stock?.map((x) => x.company)).toEqual(["Бета", "Альфа"]);
  });

  it("файл не скачался (сеть, HTTP) — на следующем запуске пробуем снова", async () => {
    const listing = [file(1, "2026-11-17T10:00:00+03:00")];
    const bodies: Record<string, Buffer | number> = { "https://disk.example.test/1": 503 };
    const s = setup(listing, bodies);
    const first = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(first.report).toBeUndefined();
    expect(first.notice).toMatch(/файл не скачался: HTTP 503/);
    bodies["https://disk.example.test/1"] = good;
    const second = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(second.report?.dataDate).toBe("2026-11-16");
    expect(second.notice).toBeUndefined();
  });

  it("файл удалили из чата — он пропадает из истории, отчёт берётся из предыдущего", async () => {
    const listing = [file(1, "2026-11-16T10:00:00+03:00"), file(2, "2026-11-17T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": shifted, "https://disk.example.test/2": good });
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    listing.pop();
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.file?.id).toBe("1");
    expect(view.report?.debtors.total).toBe(1_000_000);
    expect(view.snapshots.map((x) => x.debtors)).toEqual([1_000_000]);
  });

  it("папка не прочиталась — последний сохранённый отчёт с пояснением", async () => {
    const listing = [file(1, "2026-11-17T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": good });
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    s.reader.listAllBatched.mockRejectedValueOnce(new Error("ACCESS_DENIED"));
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.report?.dataDate).toBe("2026-11-16");
    expect(view.notice).toMatch(/Не удалось прочитать папку чата/);
  });

  it("без ключа кэша: разбирает только самый свежий файл и ничего не пишет на диск", async () => {
    captureLogs();
    const listing = [file(1, "2026-11-16T10:00:00+03:00"), file(2, "2026-11-17T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": shifted, "https://disk.example.test/2": good });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: "", fetchFn: s.fetchFn });
    expect(view.file?.id).toBe("2");
    expect(s.asked).toEqual(["https://disk.example.test/2"]);
    expect(fs.existsSync(s.cachePath)).toBe(false);
    expect(logs.join("\n")).toMatch(/без ключа кэша истории нет/);
  });

  it("нет папки в конфиге или в чате нет файлов — понятная ошибка вместо страницы", async () => {
    expect((await loadFinanceView({})).error).toMatch(/finance\.diskFolderId/);
    const s = setup([], {});
    expect((await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn })).error).toMatch(/нет ни одного \.xlsx/);
  });

  it("локальный файл (--finance-file) разбирается без Битрикса", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fin-local-"));
    const local = path.join(dir, "отчет.xlsx");
    fs.writeFileSync(local, good);
    const view = await loadFinanceView({ localFile: local });
    expect(view.file?.name).toBe("отчет.xlsx");
    expect(view.report?.dataDate).toBe("2026-11-16");
    fs.writeFileSync(local, "broken");
    expect((await loadFinanceView({ localFile: local })).error).toBe("Файл «отчет.xlsx» не разобран: файл не читается как .xlsx");
  });
});

describe("финансы: книга ФО (ОПиУ) в том же чате", () => {
  const FO_NAME = "ФО Альфа 2025-2026 9 мес.xlsx";
  const foFile = (id: number, created: string) => ({ ...file(id, created), NAME: FO_NAME });

  it("книга ФО свежее ежедневного отчёта: отчёт — из своего файла без пояснения, ОПиУ — из книги", async () => {
    captureLogs();
    const listing = [file(1, "2026-11-26T10:30:00+03:00"), foFile(2, "2026-11-26T10:51:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": good, "https://disk.example.test/2": fo });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.file?.id).toBe("1");
    expect(view.report?.dataDate).toBe("2026-11-16");
    expect(view.notice).toBeUndefined();
    expect(view.error).toBeUndefined();
    expect(view.statementFile).toEqual({ id: "2", name: FO_NAME, uploadedAt: "2026-11-26T10:51:00+03:00" });
    expect(view.statement?.lines[0].label).toBe("Выручка");
    expect(view.statement?.lines[0].breakdown?.rows.length).toBe(24);
    expect(view.statementNotice).toBeUndefined();
    // в историю по дням книга ФО не попадает
    expect(view.snapshots.map((x) => x.dataDate)).toEqual(["2026-11-16"]);
    const log = logs.join("\n");
    expect(log).toMatch(/Файлов в чате: 2, разобрано сейчас: 2, отчёт на 2026-11-16/);
    expect(log).toMatch(/ОПиУ из книги ФО: статей 17, с расшифровкой 8, предупреждений сверки 0/);
    expect(log).not.toMatch(/Альфа|Школа|Покупатель|000 000|9000000/);
  });

  it("книга ФО старше свежих отчётов: остаётся в кэше, заново не скачивается и показывается", async () => {
    const listing = [foFile(1, "2026-11-20T10:00:00+03:00"), file(2, "2026-11-24T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": fo, "https://disk.example.test/2": good, "https://disk.example.test/3": shifted });
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(JSON.parse(fs.readFileSync(s.cachePath, "utf8")).alg).toBe("aes-256-gcm");
    expect(fs.readFileSync(s.cachePath, "utf8")).not.toMatch(/Покупатель|Выручка/);
    listing.push(file(3, "2026-11-25T10:00:00+03:00"));
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(s.asked.filter((u) => u.endsWith("/1"))).toHaveLength(1);
    expect(view.file?.id).toBe("3");
    expect(view.statementFile?.id).toBe("1");
    expect(view.statement?.lines.length).toBe(17);
    expect(view.notice).toBeUndefined();
    // книгу ФО удалили из чата — раздел ОПиУ пропадает
    listing.shift();
    const after = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(after.statement).toBeUndefined();
    expect(after.statementFile).toBeUndefined();
  });

  it("новая книга ФО не разобралась: пояснение в разделе ОПиУ, показана прошлая книга, отчёт без пояснения", async () => {
    const listing = [foFile(1, "2026-10-01T10:00:00+03:00"), file(2, "2026-11-25T10:00:00+03:00"), { ...foFile(3, "2026-11-26T10:51:00+03:00"), NAME: "ФО новая.xlsx" }];
    const s = setup(listing, { "https://disk.example.test/1": fo, "https://disk.example.test/2": good, "https://disk.example.test/3": foBroken });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.file?.id).toBe("2");
    expect(view.notice).toBeUndefined();
    expect(view.statementFile?.id).toBe("1");
    expect(view.statementNotice).toBe("Последняя книга ФО «ФО новая.xlsx» (26.11 12:51) не разобрана: на листе «ОПиУ» нет шапки «Наименование показателей» с месяцами. Показан ОПиУ из «ФО Альфа 2025-2026 9 мес.xlsx» (01.10 12:00).");
  });

  it("кэш от прошлой версии разбора, где книга ФО числилась неразобранным отчётом: разбирается заново", async () => {
    const listing = [file(1, "2026-11-26T10:30:00+03:00"), foFile(2, "2026-11-26T10:51:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": good, "https://disk.example.test/2": fo });
    await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    const cache = JSON.parse(decryptPayload(fs.readFileSync(s.cachePath, "utf8"), KEY));
    // так кэш выглядел на сайте 26.11: книга ФО — «не разобран: нет листа «Ежед.»»
    const old = { v: 3, files: { ...cache.files, "2": { name: FO_NAME, createTime: listing[1].CREATE_TIME, updateTime: listing[1].UPDATE_TIME, ok: false, error: "нет листа «Ежед.»" } }, latest: cache.latest };
    fs.writeFileSync(s.cachePath, encryptPayload(JSON.stringify(old), KEY), "utf8");
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(FINANCE_PARSE_VERSION).toBeGreaterThan(3);
    expect(view.notice).toBeUndefined();
    expect(view.statement?.lines.length).toBe(17);
  });

  it("без ключа кэша: книга ФО свежее — разбирается она и ближайший отчёт, дальше не скачиваем", async () => {
    const listing = [file(1, "2026-11-24T10:00:00+03:00"), file(2, "2026-11-25T10:00:00+03:00"), foFile(3, "2026-11-26T10:00:00+03:00")];
    const s = setup(listing, { "https://disk.example.test/1": shifted, "https://disk.example.test/2": good, "https://disk.example.test/3": fo });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: "", fetchFn: s.fetchFn });
    expect(s.asked).toEqual(["https://disk.example.test/3", "https://disk.example.test/2"]);
    expect(view.file?.id).toBe("2");
    expect(view.statementFile?.id).toBe("3");
  });

  it("в чате только книга ФО — понятная ошибка про ежедневный отчёт, ОПиУ показывается", async () => {
    const s = setup([foFile(1, "2026-11-26T10:00:00+03:00")], { "https://disk.example.test/1": fo });
    const view = await loadFinanceView({ reader: s.reader, folderId: 1, cachePath: s.cachePath, secretKey: KEY, fetchFn: s.fetchFn });
    expect(view.report).toBeUndefined();
    expect(view.notice).toBeUndefined();
    expect(view.error).toBe("В чате «Финансовый отчет» нет ежедневного отчёта — только книга ФО.");
    expect(view.statement?.lines.length).toBe(17);
  });

  it("локальные файлы (несколько --finance-file): ежедневный отчёт и книга ФО", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pult-fin-local-"));
    const daily = path.join(dir, "отчет.xlsx");
    const book = path.join(dir, "фо.xlsx");
    fs.writeFileSync(daily, good);
    fs.writeFileSync(book, fo);
    const both = await loadFinanceView({ localFiles: [book, daily] });
    expect(both.report?.dataDate).toBe("2026-11-16");
    expect(both.file?.name).toBe("отчет.xlsx");
    expect(both.statementFile?.name).toBe("фо.xlsx");
    expect(both.statement?.lines.length).toBe(17);
    const only = await loadFinanceView({ localFile: book });
    expect(only.statement?.lines.length).toBe(17);
    expect(only.error).toBe("Среди локальных файлов нет ежедневного отчёта: только книга ФО «фо.xlsx».");
    fs.writeFileSync(book, foBroken);
    const broken = await loadFinanceView({ localFiles: [daily, book] });
    expect(broken.report?.dataDate).toBe("2026-11-16");
    expect(broken.statement).toBeUndefined();
    expect(broken.statementNotice).toBe("Книга ФО «фо.xlsx» не разобрана: на листе «ОПиУ» нет шапки «Наименование показателей» с месяцами.");
  });
});
