import type { BitrixTransport } from "../../reporting/readOnlyClient.js";

interface DiskChildItem {
  ID: string | number;
  NAME: string;
  TYPE: "file" | "folder";
  DOWNLOAD_URL?: string;
  UPDATE_TIME?: string;
}

export function parseDateKeyFromFileName(fileName: string): string {
  const m = fileName.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2,4})/);
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const month = m[2].padStart(2, "0");
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${month}-${day}`;
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

    if (dateCurr !== dateBest) {
      return dateCurr > dateBest ? curr : best;
    }

    const timeCurr = curr.UPDATE_TIME ?? "";
    const timeBest = best.UPDATE_TIME ?? "";
    return timeCurr > timeBest ? curr : best;
  }, null);
}

export async function fetchLatestRegisterFromDisk(
  client: BitrixTransport,
  folderId: number | string
): Promise<{ buffer: Buffer; fileName: string; updateTime: string } | null> {
  if (!folderId || folderId === "0" || folderId === 0) {
    return null;
  }

  const res = (await client.call("disk.folder.getchildren", { id: folderId })) as {
    result?: DiskChildItem[];
  };

  const children = Array.isArray(res?.result) ? res.result : [];
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
