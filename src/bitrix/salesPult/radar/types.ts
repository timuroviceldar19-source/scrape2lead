export type RadarColumnKey = "submitToday" | "discussion" | "secondChance";

export interface RadarCard {
  id: string;
  dealUrl: string;
  sourceType: "lot" | "plan";
  lotNumber?: string;
  planNumber?: string;
  announceNumber?: string;
  announceName?: string;
  lotUrl?: string;
  announceUrl?: string;
  title: string;
  itemName: string;
  qty: number;
  sum: number;
  method: string;
  status: string;
  group: "ИП" | "КТ";
  kind: string;
  customerName: string;
  customerBin: string;
  managerId: string;
  managerName: string;
  startAt: string | null;
  endAt: string | null;
  hoursLeft: number | null;
  isToday: boolean;
  isWithin48h: boolean;
  column: RadarColumnKey;
  isNewStage?: boolean;
}

export interface RadarKpis {
  totalCount: number;
  totalSum: number;
  submitCount: number;
  submitSum: number;
  discussionCount: number;
  discussionSum: number;
  secondChanceCount: number;
  secondChanceSum: number;
}

export interface RadarGroupView {
  group: "ИП" | "КТ";
  kpis: RadarKpis;
  submitToday: RadarCard[];
  discussion: RadarCard[];
  secondChance: RadarCard[];
}

export interface RadarView {
  asOf: string;
  error?: string;
  ip: RadarGroupView;
  kt: RadarGroupView;
}
