const LEGAL_FORM_PATTERNS = [
  /товарищество\s+с\s+ограниченной\s+ответственностью/gi,
  /акционерное\s+общество/gi,
  /индивидуальный\s+предприниматель/gi,
  /(^|\s)тоо(?=\s|$)/gi,
  /(^|\s)ао(?=\s|$)/gi,
  /(^|\s)ип(?=\s|$)/gi,
  /\btoo\b/gi,
  /\bao\b/gi,
  /\bip\b/gi,
  /\bllc\b/gi,
  /\bltd\b/gi,
  /\bjsc\b/gi
];

export function normalizeCompanyName(name: string): string {
  let result = name;
  for (const pattern of LEGAL_FORM_PATTERNS) {
    result = result.replace(pattern, " ");
  }

  return result
    .replace(/\([^)]*\)/g, " ")
    .replace(/["'`«»“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isUsableZakupSearchName(name: string): boolean {
  return normalizeCompanyName(name).length >= 3;
}
