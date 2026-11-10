import type { SalesPultPayload, PaceContext, SignalItem } from "./types.js";
import { plural } from "./format.js";

/** В срочном остаются только пункты, которых нет в таблицах команды. */
export function buildPultSignals(payload: SalesPultPayload, _paceContext?: PaceContext): SignalItem[] {
  const signals = payload.contractSource?.signals ?? [];
  return [
    ...signals.filter(s => s.color === "red"),
    ...signals.filter(s => s.color === "yellow"),
    ...(!payload.callsAvailable ? [{ color: "gray" as const, text: "Звонки сейчас не загружаются, цифры по звонкам неполные" }] : [])
  ];
}

export const buildSignals = buildPultSignals;

export function formatSignals(rawSignals: SignalItem[], mismatchCount = 0) {
  const signalsUrgent = rawSignals.length + mismatchCount;
  const signalsMeta = signalsUrgent
    ? plural(signalsUrgent, ["срочный пункт", "срочных пункта", "срочных пунктов"])
    : "Срочного нет";
  const signals = rawSignals.map(s => ({
    cls: s.color === "red" ? "s-bad" : s.color === "yellow" ? "s-warn" : s.color === "green" ? "s-good" : "",
    text: s.text,
    color: s.color
  }));
  return { signals, signalsUrgent, signalsMeta };
}
