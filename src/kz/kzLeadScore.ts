import type { CompanyCard, LeadPriority } from "./tenderTypes.js";

export interface ScoredCompanyCard extends CompanyCard {
  lead_priority: LeadPriority;
  high_volume: boolean;
}

const HIGH_VOLUME_THRESHOLD = 50;
const PRIORITY_A_ACTIVE_MIN = 10;
const PRIORITY_A_BUDGET_MIN = 50_000_000;
const PRIORITY_A_COMBO_ACTIVE_MIN = 5;
const PRIORITY_A_COMBO_BUDGET_MIN = 10_000_000;
const PRIORITY_B_ACTIVE_MIN = 3;
const PRIORITY_B_BUDGET_MIN = 1_000_000;
const PRIORITY_B_TOTAL_MIN = 20;

export function scoreCompanyCards(cards: CompanyCard[]): ScoredCompanyCard[] {
  return cards.map(scoreCompanyCard);
}

export function scoreCompanyCard(card: CompanyCard): ScoredCompanyCard {
  const activeBudget = card.tender_active_budget_sum ?? 0;
  const activeCount = card.tender_count_active;
  const totalCount = card.tender_count_total;

  let lead_priority: LeadPriority = "";
  if (totalCount > 0) {
    if (
      activeCount >= PRIORITY_A_ACTIVE_MIN
      || activeBudget >= PRIORITY_A_BUDGET_MIN
      || (activeCount >= PRIORITY_A_COMBO_ACTIVE_MIN && activeBudget >= PRIORITY_A_COMBO_BUDGET_MIN)
    ) {
      lead_priority = "A";
    } else if (
      activeCount >= PRIORITY_B_ACTIVE_MIN
      || activeBudget >= PRIORITY_B_BUDGET_MIN
      || totalCount >= PRIORITY_B_TOTAL_MIN
    ) {
      lead_priority = "B";
    } else {
      lead_priority = "C";
    }
  }

  return {
    ...card,
    lead_priority,
    high_volume: totalCount >= HIGH_VOLUME_THRESHOLD
  };
}
