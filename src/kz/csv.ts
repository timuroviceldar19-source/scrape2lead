import fs from "node:fs";

export function readBinsFromCsv(filePath: string): string[] {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[;,]/)[0]?.trim() ?? "")
    .filter((value) => value !== "" && value.toLowerCase() !== "bin");
}

export function isValidBin(bin: string): boolean {
  return /^\d{12}$/.test(bin);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
