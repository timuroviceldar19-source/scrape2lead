import type { ReadOnlyBitrixClient } from "../../reporting/readOnlyClient.js";

export type DiskChildItem = {
  ID: string | number;
  NAME: string;
  TYPE: "file" | "folder";
  DOWNLOAD_URL?: string;
  UPDATE_TIME?: string;
};

export function getFileRevision(fileName: string): number {
  const m = fileName.match(/\((\d+)\)/);
  return m ? parseInt(m[1], 10) : 0;
}

export function parseDateKeyFromFileName(fileName: string): string {
  const m = fileName.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/);
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const month = m[2].padStart(2, "0");
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${month}-${day}`;
}

export function compareRegisterFiles(
  a: { dateKey: string; updateTime?: string; fileName: string },
  b: { dateKey: string; updateTime?: string; fileName: string }
): number {
  if (a.dateKey !== b.dateKey) {
    return a.dateKey.localeCompare(b.dateKey);
  }
  const timeA = a.updateTime || "";
  const timeB = b.updateTime || "";
  if (timeA !== timeB) {
    return timeA.localeCompare(timeB);
  }
  const revA = getFileRevision(a.fileName);
  const revB = getFileRevision(b.fileName);
  return revA - revB;
}

export function pickLatestRegisterFile(items: DiskChildItem[]): DiskChildItem | null {
  const xlsxFiles = items.filter(
    (item) => item.TYPE === "file" && /\.xlsx$/i.test(item.NAME) && /ОП/i.test(item.NAME)
  );

  if (xlsxFiles.length === 0) return null;

  return xlsxFiles.reduce<DiskChildItem | null>((best, curr) => {
    if (!best) return curr;
    const dateCurr = parseDateKeyFromFileName(curr.NAME);
    const dateBest = parseDateKeyFromFileName(best.NAME);

    const cmp = compareRegisterFiles(
      { dateKey: dateCurr, updateTime: curr.UPDATE_TIME, fileName: curr.NAME },
      { dateKey: dateBest, updateTime: best.UPDATE_TIME, fileName: best.NAME }
    );
    return cmp > 0 ? curr : best;
  }, null);
}

export function pickMonthlyFinalRegisterFiles(items: DiskChildItem[]): Map<string, DiskChildItem> {
  const xlsxFiles = items.filter(
    (item) => item.TYPE === "file" && /\.xlsx$/i.test(item.NAME) && /ОП/i.test(item.NAME)
  );

  const byMonth = new Map<string, DiskChildItem>();

  for (const item of xlsxFiles) {
    const dateKey = parseDateKeyFromFileName(item.NAME);
    if (!dateKey) continue;
    const month = dateKey.slice(0, 7);

    const existing = byMonth.get(month);
    if (!existing) {
      byMonth.set(month, item);
      continue;
    }

    const dateExisting = parseDateKeyFromFileName(existing.NAME);
    const cmp = compareRegisterFiles(
      { dateKey, updateTime: item.UPDATE_TIME, fileName: item.NAME },
      { dateKey: dateExisting, updateTime: existing.UPDATE_TIME, fileName: existing.NAME }
    );
    if (cmp > 0) {
      byMonth.set(month, item);
    }
  }

  return byMonth;
}

export async function fetchLatestRegisterFromDisk(
  client: Pick<ReadOnlyBitrixClient, "listAllBatched">,
  folderId: number | string
): Promise<{ buffer: Buffer; fileName: string; updateTime: string } | null> {
  if (!folderId || folderId === "0" || folderId === 0) {
    return null;
  }

  const children = await client.listAllBatched<DiskChildItem>("disk.folder.getchildren", { id: folderId });
  const latest = pickLatestRegisterFile(children);
  if (!latest || !latest.DOWNLOAD_URL) {
    return null;
  }

  const response = await fetch(latest.DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`Failed to download ${latest.NAME}: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName: latest.NAME,
    updateTime: latest.UPDATE_TIME ?? new Date().toISOString()
  };
}

export interface FetchRegisterFilesResult {
  files: Array<{ buffer: Buffer; fileName: string; updateTime: string }>;
  failedFiles: Array<{ fileName: string; reason: string }>;
}

export async function fetchRegisterFilesFromDisk(
  client: Pick<ReadOnlyBitrixClient, "listAllBatched">,
  folderId: number | string,
  options?: { monthlyOnly?: boolean }
): Promise<Array<{ buffer: Buffer; fileName: string; updateTime: string }> & { failedFiles: Array<{ fileName: string; reason: string }> }> {
  const emptyRes = Object.assign([] as Array<{ buffer: Buffer; fileName: string; updateTime: string }>, {
    failedFiles: [] as Array<{ fileName: string; reason: string }>
  });
  if (!folderId || folderId === "0" || folderId === 0) {
    return emptyRes;
  }

  const children = await client.listAllBatched<DiskChildItem>("disk.folder.getchildren", { id: folderId });
  const candidates = options?.monthlyOnly
    ? Array.from(pickMonthlyFinalRegisterFiles(children).values())
    : children.filter(
        (item) => item.TYPE === "file" && /\.xlsx$/i.test(item.NAME) && /ОП/i.test(item.NAME)
      );

  const results: Array<{ buffer: Buffer; fileName: string; updateTime: string }> = [];
  const failedFiles: Array<{ fileName: string; reason: string }> = [];

  for (const item of candidates) {
    if (!item.DOWNLOAD_URL) {
      failedFiles.push({ fileName: item.NAME, reason: "Отсутствует DOWNLOAD_URL" });
      continue;
    }
    try {
      const response = await fetch(item.DOWNLOAD_URL);
      if (!response.ok) {
        console.warn(`[Disk] Не удалось скачать ${item.NAME}: HTTP ${response.status}`);
        failedFiles.push({ fileName: item.NAME, reason: `HTTP ${response.status}` });
        continue;
      }
      const arrayBuffer = await response.arrayBuffer();
      results.push({
        buffer: Buffer.from(arrayBuffer),
        fileName: item.NAME,
        updateTime: item.UPDATE_TIME ?? ""
      });
    } catch (err) {
      console.warn(`[Disk] Ошибка при скачивании ${item.NAME}:`, err);
      failedFiles.push({ fileName: item.NAME, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return Object.assign(results, { failedFiles });
}
