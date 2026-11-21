// «Радар» для вида менеджера: только его карточки, KPI по тем же правилам, что у полного Радара.
// Объект собирается заново из известных полей, поэтому посторонние поля полного Радара в вид не попадают.

import { computeRadarKpis, emptyRadarGroup, type RadarColumns } from "./aggregate.js";
import type { RadarCard, RadarGroupView, RadarView } from "./types.js";

export function filterRadarForManager(view: RadarView, managerId: string): RadarView {
  const id = String(managerId ?? "").trim();
  // Без ID не показываем ничего: у неназначенных лотов managerId тоже пустой.
  const mine = (cards: readonly RadarCard[] | undefined): RadarCard[] =>
    id ? (cards ?? []).filter((c) => String(c.managerId) === id) : [];

  const filterGroup = (source: RadarGroupView | undefined, group: "ИП" | "КТ"): RadarGroupView => {
    if (!source) return emptyRadarGroup(group);
    const columns: RadarColumns = {
      submitToday: mine(source.submitToday),
      discussion: mine(source.discussion),
      secondChance: mine(source.secondChance),
      missed: mine(source.missed)
    };
    return { group, kpis: computeRadarKpis(columns), ...columns };
  };

  return {
    asOf: view.asOf,
    ...(view.error !== undefined ? { error: view.error } : {}),
    ip: filterGroup(view.ip, "ИП"),
    kt: filterGroup(view.kt, "КТ")
  };
}
