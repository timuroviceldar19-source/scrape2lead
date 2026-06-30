const WEIGHTS_1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const WEIGHTS_2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

/** 12-digit format (legacy helper). */
export function isValidBinFormat(bin: string): boolean {
  return /^\d{12}$/.test(bin);
}

/** Kazakhstan BIN/IIN control digit (RFC-style weights mod 11). */
export function isValidKzBinChecksum(bin: string): boolean {
  if (!isValidBinFormat(bin)) return false;
  const digits = bin.split("").map(Number);
  let check = checksumWithWeights(digits, WEIGHTS_1);
  if (check === 10) {
    check = checksumWithWeights(digits, WEIGHTS_2);
  }
  if (check === 10) check = 0;
  return check === digits[11];
}

function checksumWithWeights(digits: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum += digits[i]! * weights[i]!;
  }
  return sum % 11;
}

// Note: \b is ASCII-only — use explicit delimiters for Cyrillic ТОО/ИП.
const TOO_NAME_RE = /ТОО|Товарищество\s+с\s+ограниченной\s+ответственностью/i;
const NON_TOO_NAME_RE = /(?:^|\s|")ИП(?:\s|"|$)|Индивидуальн|физическ\w+\s+лиц/i;

/** Name looks like a ТОО (not ИП / физлицо). */
export function isTooCompanyName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (NON_TOO_NAME_RE.test(trimmed)) return false;
  return TOO_NAME_RE.test(trimmed);
}

export interface HarvestBinCandidate {
  bin: string;
  name: string;
  participant_id: string | null;
}

export function validateHarvestCandidate(candidate: HarvestBinCandidate): {
  accepted: boolean;
  reason?: string;
} {
  if (!isValidBinFormat(candidate.bin)) {
    return { accepted: false, reason: "invalid_format" };
  }
  if (!isTooCompanyName(candidate.name)) {
    return { accepted: false, reason: "not_too_name" };
  }
  if (!isValidKzBinChecksum(candidate.bin)) {
    return { accepted: false, reason: "invalid_checksum" };
  }
  return { accepted: true };
}
