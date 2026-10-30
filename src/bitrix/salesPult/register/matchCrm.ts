import type {
  RegisterRow,
  RegisterContract,
  CrmWonDeal
} from "./types.js";

const STOP_WORDS = new Set(
  ("кгу гу гкп гккп ргп ркп рг ргу коммунальное государственное учреждение " +
    "казенное предприятие предприятие на праве хозяйственного ведения ведения " +
    "отдела отдел образования управления области города района по и имени им " +
    "тоо ао нао ип некоммерческое акционерное общество средняя школа общеобразовательная №"
  ).split(" ")
);

export function tokenizeCustomerName(s: string): Set<string> {
  const words = String(s)
    .toLowerCase()
    .replace(/[^0-9a-zа-яёәғқңөұүһі№ ]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

export function calculateNameSimilarity(a: string, b: string): number {
  const setA = tokenizeCustomerName(a);
  const setB = tokenizeCustomerName(b);
  if (!setA.size || !setB.size) return 0;
  let matchCount = 0;
  for (const w of setA) {
    if (setB.has(w)) matchCount++;
  }
  return matchCount / Math.min(setA.size, setB.size);
}

export function extractEntityNumbers(s: string): Set<string> {
  const nums = new Set<string>();
  if (!s) return nums;
  const str = String(s);

  // 1. Standalone symbol indicators: №, #, or isolated uppercase N before digits
  // Boundaries: (?<![\p{L}\d]) before indicator, (?![\p{L}\d]) after digits
  const m1 = str.matchAll(/(?<![\p{L}\d])(?:[№#]|N)\s*(\d+)(?![\p{L}\d])/gu);
  for (const m of m1) {
    nums.add(m[1]);
  }

  // 2. Named entities with or without symbol: "школа 5", "ясли-сад 14", "лицей 20", "школа №5"
  const m2 = str.matchAll(
    /(?<![\p{L}\d])(?:школа|ясли-сад|сад|гимназия|лицей|колледж|поликлиника|больница|комплекс)\s+(?:[№#]|N\s*)?(\d+)(?![\p{L}\d])/giu
  );
  for (const m of m2) {
    nums.add(m[1]);
  }
  return nums;
}

export function hasConflictingEntityNumbers(customerA: string, textB: string): boolean {
  const numsA = extractEntityNumbers(customerA);
  const numsB = extractEntityNumbers(textB);
  if (numsA.size === 0 || numsB.size === 0) return false;
  for (const n of numsA) {
    if (numsB.has(n)) return false;
  }
  return true;
}

export function groupRegisterContracts(rows: RegisterRow[]): RegisterContract[] {
  const map = new Map<string, RegisterContract>();

  for (const r of rows) {
    const key = `${r.date}|${r.customer}|${r.manager}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        date: r.date,
        customer: r.customer,
        manager: r.manager,
        sale: r.sale,
        val: r.val,
        bonusMop: r.bonusMop,
        bonusRop: r.bonusRop,
        lines: 1,
        products: [r.product],
        type: r.type,
        channel: r.channel,
        group: r.group,
        kind: r.kind,
        qty: r.qty
      });
    } else {
      existing.sale += r.sale;
      if (existing.val !== null && r.val !== null) {
        existing.val += r.val;
      } else if (existing.val === null && r.val !== null) {
        existing.val = r.val;
      }
      existing.bonusMop += r.bonusMop;
      existing.bonusRop += r.bonusRop;
      existing.lines += 1;
      existing.qty += r.qty;
      if (!existing.products.includes(r.product)) {
        existing.products.push(r.product);
      }
    }
  }

  return [...map.values()];
}

function managerMatches(
  regManager: string,
  crmManager: string,
  aliases?: Record<string, string>
): boolean {
  const rNorm = String(aliases?.[regManager] ?? regManager ?? "").toLowerCase().trim();
  const cNorm = String(crmManager ?? "").toLowerCase().trim();
  if (rNorm === cNorm) return true;
  const rFirst = rNorm.split(/\s+/)[0] ?? "";
  const cFirst = cNorm.split(/\s+/)[0] ?? "";
  if (rFirst && cFirst && rFirst === cFirst) return true;
  if (rFirst.length >= 4 && cFirst.startsWith(rFirst.slice(0, 4))) return true;
  return false;
}

function checkAmountMatch(contractSale: number, dealAmount: number): boolean {
  if (contractSale <= 0 || dealAmount <= 0) return false;
  const ratioVat = dealAmount / (contractSale * 1.16);
  if (ratioVat >= 0.8 && ratioVat <= 1.25) return true;
  const ratioRaw = dealAmount / contractSale;
  if (ratioRaw >= 0.8 && ratioRaw <= 1.25) return true;
  return false;
}

export interface MatchCrmResult {
  matched: Array<{ contract: RegisterContract; deal: CrmWonDeal; score: number }>;
  missing: RegisterContract[];
  extra: CrmWonDeal[];
}

export function matchRegisterWithCrm(
  contracts: RegisterContract[],
  deals: CrmWonDeal[],
  options?: { managerAliases?: Record<string, string> }
): MatchCrmResult {
  const sortedContracts = [...contracts].sort((a, b) => b.sale - a.sale);
  const usedDealIds = new Set<string>();
  const matched: Array<{ contract: RegisterContract; deal: CrmWonDeal; score: number }> = [];
  const missing: RegisterContract[] = [];

  for (const c of sortedContracts) {
    let bestDeal: CrmWonDeal | null = null;
    let bestScore = -1;

    for (const d of deals) {
      if (usedDealIds.has(d.id)) continue;
      if (!managerMatches(c.manager, d.manager, options?.managerAliases)) continue;

      const dealText = [d.company, d.title].filter(Boolean).join(" ");
      if (hasConflictingEntityNumbers(c.customer, dealText)) continue;

      const simTitle = calculateNameSimilarity(c.customer, d.title);
      const simComp = calculateNameSimilarity(c.customer, d.company);
      const sim = Math.max(simTitle, simComp);
      const amtOk = checkAmountMatch(c.sale, d.amount);
      const score = sim + (amtOk ? 0.6 : 0);

      if (score >= 0.9 && score > bestScore) {
        bestScore = score;
        bestDeal = d;
      }
    }

    if (bestDeal) {
      usedDealIds.add(bestDeal.id);
      matched.push({ contract: c, deal: bestDeal, score: bestScore });
    } else {
      missing.push(c);
    }
  }

  const extra = deals.filter((d) => !usedDealIds.has(d.id));
  return { matched, missing, extra };
}
