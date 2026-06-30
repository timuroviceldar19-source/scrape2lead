import { countFirmRecords } from "./mapper.js";

export interface SoftBlockEvidence {
  signal: "page_text" | "search_attributes";
  reason: "empty_results_text" | "throttled" | "partial" | "search_attributes_zero_firms";
  firmCount: number;
  url?: string;
  matchedText?: string[];
  searchAttributes?: Record<string, unknown>;
  topLevelShape?: string;
}

export interface SoftBlockClassification {
  reason: "soft_blocked" | "throttled";
  evidence: SoftBlockEvidence[];
}

export class SoftBlockError extends Error {
  readonly code = "soft_blocked";

  constructor(
    message: string,
    readonly classification: SoftBlockClassification,
    readonly screenshotPath?: string
  ) {
    super(message);
    this.name = "SoftBlockError";
  }
}

const EMPTY_TEXT_SIGNATURES: Array<{ label: string; re: RegExp }> = [
  { label: "Ничего не нашлось", re: /Ничего\s+не\s+нашлось/i },
  { label: "попробуйте уточнить запрос", re: /попробуйте\s+уточнить\s+запрос/i },
  { label: "Добавить организацию", re: /Добавить\s+организацию/i }
];

export function classifySoftBlock(bodyText: string, payloadEvidence: SoftBlockEvidence[]): SoftBlockClassification | null {
  const evidence = [...payloadEvidence];
  const textEvidence = findSoftBlockTextEvidence(bodyText);
  if (textEvidence) evidence.push(textEvidence);
  if (evidence.length === 0) return null;
  const throttled = evidence.some((item) => item.reason === "throttled" || item.reason === "partial");
  return {
    reason: throttled ? "throttled" : "soft_blocked",
    evidence
  };
}

export function findSoftBlockTextEvidence(bodyText: string): SoftBlockEvidence | null {
  const matchedText = EMPTY_TEXT_SIGNATURES
    .filter(({ re }) => re.test(bodyText))
    .map(({ label }) => label);

  if (matchedText.length !== EMPTY_TEXT_SIGNATURES.length) return null;
  return {
    signal: "page_text",
    reason: "empty_results_text",
    firmCount: 0,
    matchedText
  };
}

export function findSoftBlockPayloadEvidence(payload: unknown, url?: string): SoftBlockEvidence[] {
  const firmCount = countFirmRecords(payload);
  if (firmCount > 0) return [];

  return findSearchAttributes(payload).flatMap((attrs) => {
    const reason = classifySearchAttributes(attrs);
    if (!reason) return [];
    return [{
      signal: "search_attributes",
      reason,
      firmCount,
      url,
      searchAttributes: summarizeSearchAttributes(attrs),
      topLevelShape: summarizeTopLevelShape(payload)
    }];
  });
}

function classifySearchAttributes(attrs: Record<string, unknown>): SoftBlockEvidence["reason"] | null {
  if (attrs.is_throttled === true) return "throttled";
  if (attrs.is_partial === true) return "partial";
  if (
    ("is_throttled" in attrs || "is_partial" in attrs) &&
    (attrs.throttle_reason !== undefined || attrs.throttling_reason !== undefined || attrs.reason !== undefined)
  ) {
    return "search_attributes_zero_firms";
  }
  return null;
}

function findSearchAttributes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(findSearchAttributes);
  if (!isRecord(value)) return [];

  const own = isRecord(value.search_attributes) ? [value.search_attributes] : [];
  return [
    ...own,
    ...Object.values(value).flatMap(findSearchAttributes)
  ];
}

function summarizeSearchAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([key]) => key === "is_throttled" || key === "is_partial" || key.includes("throttl") || key === "reason")
      .slice(0, 8)
  );
}

export function summarizeTopLevelShape(payload: unknown): string {
  if (Array.isArray(payload)) return "array";
  if (isRecord(payload)) return `object:${Object.keys(payload).slice(0, 12).join(",")}`;
  return typeof payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
