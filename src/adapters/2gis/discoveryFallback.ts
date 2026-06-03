import type { Page } from "playwright";
import { logger } from "../../logger.js";
import type { RawCompanyCard, SearchQuery } from "../../types.js";
import { classifySoftBlock } from "./softBlock.js";

/**
 * DOM-fallback discovery for 2GIS.
 *
 * The primary discovery path is the XHR/JSON capture in {@link ApiCapture}.
 * When it returns no firm payloads the adapter falls back to scraping the
 * already-rendered results list. The previous implementation grabbed the
 * anchors that happened to be in the DOM at the moment of the call, so it
 * was capped to the few firms visible above the fold (~12 in the
 * Novosibirsk smoke test). This module scrolls the results panel
 * progressively, collecting firm cards across multiple scroll batches,
 * stopping on the agreed conditions (limit reached, no new cards after N
 * scrolls, anti-bot wall, max scrolls, timeout).
 *
 * 2GIS renders the results list as a virtual scroller: only ~12 firm
 * anchors ever live in the DOM (the visible window of an
 * `overflow: hidden` panel with `scrollHeight ≈ 4146` and
 * `clientHeight ≈ 695`). Mouse wheel, `End`, `PageDown`, and
 * `scrollIntoView` all leave the DOM at 12 anchors, so the scroll loop
 * alone cannot exceed that. The full list of 131+ firms is in the
 * `catalog.api.2gis.ru/3.0/markers/clustered` XHR response, which
 * {@link ApiCapture} deliberately does not classify as a "firm payload"
 * (the strict mapper rejects its composite-id format and missing
 * context fields). To honour the constraint that the mapper and the
 * primary capture path stay untouched, the adapter attaches a separate
 * listener for `markers/clustered` responses and feeds the raw
 * payloads into this module via the `markersPayloads` option. The
 * synthesis helper at the bottom of this file ({@link
 * synthesizeCardsFromMarkersPayload}) turns them into firm cards
 * using the same junk-name patterns as the mapper, without
 * duplicating its full validation chain.
 *
 * Everything in this file is intentionally narrow:
 *  - it only handles discovery (no detail extraction, no contact reveal);
 *  - it only touches the DOM fallback path (API capture remains primary);
 *  - it does not alter proxy or rate-limit logic;
 *  - it does not weaken soft-block / CAPTCHA detection — the soft-block
 *    classifier is reused as-is and the CAPTCHA detector is invoked
 *    between scroll batches by the adapter;
 *  - the marker-payload synthesis is a one-way *supplement*: it never
 *    replaces the DOM scroll-and-collect, only tops it up when the DOM
 *    could not reach the target on its own.
 */

/**
 * One anchor pulled out of the 2GIS results panel. Kept minimal and
 * serialisable so the orchestration can hand it to pure helpers (and the
 * unit tests can build fixtures without spinning up Playwright).
 */
export interface FirmCardAnchor {
  href: string;
  text: string;
  ariaLabel: string;
}

/**
 * Firm card distilled from an anchor. `externalId` is the canonical 2GIS
 * firm id (long numeric string); `name` is the visible anchor text (or
 * aria-label as fallback); `url` is the original anchor href, stripped of
 * query strings so per-session `stat=` tokens never enter persistence.
 */
export interface FirmCardCandidate {
  externalId: string;
  name: string;
  url: string;
}

/** Regex matching `/firm/<digits>` segments in 2GIS list anchors. */
export const FIRM_HREF_RE = /\/firm\/(\d{6,})(?:[/?#]|$)/;

/**
 * Anchor visible-text patterns that mark promo / sponsored entries. 2GIS
 * surfaces "Реклама" labels on paid placements; those must never be
 * collected as organic firm cards. Match is intentionally narrow so a
 * firm whose name contains "Промо" as part of its brand is not rejected;
 * the patterns require the word to stand alone or as a distinct token.
 */
const PROMO_TEXT_RE = /(?:^|\b)(?:реклама|sponsored|advert(?:ised|isement)?)(?:\b|$)/i;

/**
 * Pull the firm id out of an anchor href and assemble a clean
 * {@link FirmCardCandidate}. Returns `null` for anchors that do not
 * carry a valid `/firm/<numeric-id>/` path, that have no visible name,
 * or that are tagged as promo / sponsored entries. Exported for direct
 * unit testing without a live browser.
 */
export function anchorToFirmCandidate(anchor: FirmCardAnchor): FirmCardCandidate | null {
  const match = anchor.href.match(FIRM_HREF_RE);
  if (!match) return null;
  const externalId = match[1];
  const text = (anchor.text ?? "").replace(/\s+/g, " ").trim();
  const aria = (anchor.ariaLabel ?? "").replace(/\s+/g, " ").trim();
  const name = text || aria;
  if (!name) return null;
  if (PROMO_TEXT_RE.test(name)) return null;
  return { externalId, name, url: stripQuery(anchor.href) };
}

/**
 * Filter and de-duplicate a batch of raw anchors into firm card
 * candidates. Order is preserved: the first occurrence of any given
 * `externalId` wins. Pure so the unit tests can pin behaviour directly.
 */
export function selectFirmCardCandidates(anchors: FirmCardAnchor[]): FirmCardCandidate[] {
  const out: FirmCardCandidate[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const candidate = anchorToFirmCandidate(anchor);
    if (!candidate) continue;
    if (seen.has(candidate.externalId)) continue;
    seen.add(candidate.externalId);
    out.push(candidate);
  }
  return out;
}

/**
 * Append a fresh batch of candidates to an already-collected list,
 * skipping any whose `externalId` is already present. Returns the new
 * list plus counts so the caller can update telemetry without
 * re-walking the merged set. `existing` is not mutated.
 */
export function mergeCandidates(
  existing: FirmCardCandidate[],
  batch: FirmCardCandidate[]
): { merged: FirmCardCandidate[]; added: number; duplicates: number } {
  const seen = new Set(existing.map((c) => c.externalId));
  const merged = existing.slice();
  let added = 0;
  let duplicates = 0;
  for (const item of batch) {
    if (seen.has(item.externalId)) {
      duplicates += 1;
      continue;
    }
    seen.add(item.externalId);
    merged.push(item);
    added += 1;
  }
  return { merged, added, duplicates };
}

/** Reason the scroll-and-collect loop terminated. Surfaced in diagnostics. */
export type StopReason =
  | "limit_reached"
  | "no_new_cards"
  | "max_scrolls"
  | "soft_blocked"
  | "captcha"
  | "timeout";

/**
 * Snapshot of the collection loop's state. The stop evaluator is pure so
 * the unit tests can pin every transition without a browser or clock.
 */
export interface CollectionState {
  collected: number;
  limit: number;
  scrollAttempts: number;
  maxScrollAttempts: number;
  consecutiveStagnantScrolls: number;
  noNewCardThreshold: number;
  deadlineMs: number;
  nowMs: number;
  softBlockDetected: boolean;
  captchaDetected: boolean;
}

/**
 * Decide whether the scroll loop should stop, and why. Precedence:
 * anti-bot detections first (captcha, soft-block) so a block aborts the
 * loop even if we already cleared the limit; then limit / no-new-cards /
 * max-scrolls / timeout. Exported for unit testing.
 */
export function evaluateStopCondition(state: CollectionState): {
  stop: boolean;
  reason?: StopReason;
} {
  if (state.captchaDetected) return { stop: true, reason: "captcha" };
  if (state.softBlockDetected) return { stop: true, reason: "soft_blocked" };
  if (state.collected >= state.limit) return { stop: true, reason: "limit_reached" };
  if (state.consecutiveStagnantScrolls >= state.noNewCardThreshold) {
    return { stop: true, reason: "no_new_cards" };
  }
  if (state.scrollAttempts >= state.maxScrollAttempts) {
    return { stop: true, reason: "max_scrolls" };
  }
  if (state.nowMs >= state.deadlineMs) return { stop: true, reason: "timeout" };
  return { stop: false };
}

export interface DomFallbackOptions {
  /** Upper bound on scroll attempts. Defaults to 60. */
  maxScrollAttempts?: number;
  /** Stop after this many consecutive scrolls produced zero new cards. Defaults to 3. */
  noNewCardThreshold?: number;
  /** Overall budget for the fallback in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Random delay range between scrolls (ms). Defaults to [800, 1600]. */
  delayRangeMs?: [number, number];
  /**
   * Captcha probe called between scroll batches. The adapter passes its
   * existing `detectCaptcha` so any wall surfaces as a thrown error and
   * aborts the run loudly (same behaviour as the rest of the adapter).
   */
  detectCaptcha?: (page: Page) => Promise<void>;
  /**
   * Raw `markers/clustered` payloads collected by the adapter's
   * separate markers listener. The orchestrator turns them into
   * candidate firm cards *only* when the DOM scroll-and-collect path
   * finishes below `query.limit`. Each payload is processed once; the
   * synthesis respects the same junk-name patterns as the mapper and
   * rejects ads / cluster markers. The synthesis never blocks the
   * loop — it is a post-loop supplement so the strict API-capture
   * path and the mapper remain untouched.
   */
  markersPayloads?: unknown[];
}

/**
 * Telemetry surfaced by {@link collectFirmCardsViaScroll}. Contains
 * counts only — never URLs, anchor text, cookies, tokens, headers, or
 * any other secret material.
 */
export interface DomFallbackTelemetry {
  collected: number;
  duplicates: number;
  scrollAttempts: number;
  perStep: number[];
  stopReason: StopReason;
  /**
   * Per-step diagnostic for the scroll action itself. Contains only
   * counts, the strategy that fired, and numeric scroll metrics — never
   * element text, URLs, class lists, or any PII. Indexed parallel to
   * `perStep` (same length, same order).
   */
  scrollProbes: ScrollProbe[];
  /**
   * Number of firm cards added by the post-loop `markers/clustered`
   * synthesis. Zero when the DOM path reached the target on its own,
   * when no marker payloads were supplied, or when every synthesized
   * candidate was a duplicate of an existing `externalId`.
   */
  markersSynthesized: number;
  /**
   * Number of synthesized marker candidates that were dropped because
   * they were duplicates of an `externalId` already in the collected
   * set (or that were filtered as ads / clusters / junk-name rows by
   * the synthesis helper).
   */
  markersRejected: number;
}

/**
 * Result of one scroll attempt. Numeric only — no element text, no
 * classnames, no URLs — so the value is safe to surface in logs.
 */
export interface ScrollProbe {
  strategy: "panel" | "window" | "scrollIntoView" | "load_more" | "no_anchors";
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  moved: boolean;
}

/**
 * Scroll the 2GIS results panel and report what actually happened. The
 * previous implementation only called `scrollBy` and was unreliable:
 *  - the ancestor-walk required `scrollHeight > clientHeight + 8` which
 *    fails when the panel is initially sized to fit content;
 *  - the `window.scrollBy` fallback cannot move a fixed-height panel.
 *
 * New strategy:
 *  1. Find every scrollable container that holds a `/firm/` anchor.
 *  2. Pick the one with the largest `scrollHeight` (the actual results
 *     panel, not a small inner sub-container).
 *  3. `scrollIntoView` the last firm anchor — virtualized lists react to
 *     this far more reliably than a blind `scrollBy`.
 *  4. If the panel still has headroom, overshoot by one viewport so
 *     the lazy-load sentinel is hit.
 *  5. Fall back to `window.scrollY` when no panel was found.
 *
 * The returned `ScrollProbe` carries only numeric fields so it is safe
 * to log without leaking page content.
 */
async function scrollResultsPanel(page: Page): Promise<ScrollProbe> {
  return page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll("a[href*='/firm/']")
    ) as HTMLElement[];
    if (anchors.length === 0) {
      const beforeY = window.scrollY;
      window.scrollBy(0, Math.max(200, window.innerHeight * 0.9));
      return {
        strategy: "no_anchors",
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: window.innerHeight,
        moved: window.scrollY !== beforeY
      } satisfies ScrollProbe;
    }

    const last = anchors[anchors.length - 1];

    // Walk up from the last (and, if needed, the first) anchor looking
    // for any overflow-y ancestor that actually has scrollable content.
    const panels: HTMLElement[] = [];
    for (const root of [last, anchors[0]]) {
      let n: Element | null = root;
      while (n) {
        const cs = window.getComputedStyle(n);
        const oy = cs.overflowY;
        if (oy === "auto" || oy === "scroll" || oy === "overlay") {
          const el = n as HTMLElement;
          if (el.scrollHeight > el.clientHeight + 1) {
            panels.push(el);
          }
        }
        n = n.parentElement;
      }
      if (panels.length > 0) break;
    }

    if (panels.length > 0) {
      const panel = panels.reduce((a, b) =>
        a.scrollHeight >= b.scrollHeight ? a : b
      );
      const before = panel.scrollTop;
      // Native browser mechanism: the virtualized list observes the
      // anchor entering the viewport and renders the next chunk.
      last.scrollIntoView({ block: "end", behavior: "auto" });
      // Overshoot by one viewport so the lazy-load sentinel at the
      // bottom of the list is hit, then clamp so we never exceed
      // `scrollHeight`.
      const maxTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
      panel.scrollTop = Math.min(maxTop, panel.scrollTop + panel.clientHeight);
      return {
        strategy: "panel",
        scrollTop: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        moved: panel.scrollTop !== before
      } satisfies ScrollProbe;
    }

    const before = window.scrollY;
    last.scrollIntoView({ block: "end", behavior: "auto" });
    return {
      strategy: "scrollIntoView",
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
      moved: window.scrollY !== before
    } satisfies ScrollProbe;
  });
}

/**
 * Click a "load more" / "show more" / "показать ещё" button if one is
 * visible. Returns `true` when a button was clicked, `false` otherwise.
 * Used as a last-resort scroll strategy when `scrollResultsPanel`
 * cannot make the virtualized list expand.
 */
async function clickLoadMoreButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const re = /(?:показ(?:ать|ывайте)\s*(?:ещ[её]|все)|загрузить\s*(?:ещ[её]|все)|load\s*more|show\s*more)/i;
    const candidates = Array.from(
      document.querySelectorAll("button, a[role='button'], a.button, a.link")
    );
    for (const el of candidates) {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!re.test(text)) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      (el as HTMLElement).click();
      return true;
    }
    return false;
  });
}

/**
 * Collect every `a[href*='/firm/']` anchor in the document. The pure
 * {@link selectFirmCardCandidates} helper does the filtering, so this
 * function stays narrow: it only walks the DOM and returns plain JSON.
 */
async function collectFirmAnchors(page: Page): Promise<FirmCardAnchor[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll("a[href*='/firm/']")].map((a) => {
      const el = a as HTMLAnchorElement;
      return {
        href: el.href,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        ariaLabel: (el.getAttribute("aria-label") ?? "").trim()
      };
    });
  });
}

/**
 * Sample the body innerText so the soft-block classifier can run
 * between scrolls. Returns an empty string on failure so a transient
 * page hiccup never trips a false positive.
 */
async function readBodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

function randomDelay(range: [number, number]): number {
  const [min, max] = range;
  return Math.floor(min + Math.random() * Math.max(1, max - min));
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

/**
 * Composite-id format used by `markers/clustered`. 2GIS concatenates the
 * real firm id (a long numeric run) with a per-session / per-position
 * hash, separated by an underscore:
 *
 *   "70000001006434211_77h39yqcdBdB9A821J7H1J2JHGIIGH1J...-c17d00544...-d8d50482465..."
 *
 * We only need the numeric prefix to get back to `/firm/<id>` URLs and
 * to dedupe across DOM and markers sources. The rest of the string is
 * cluster/identity metadata that must not enter persistence.
 */
const MARKER_FIRM_ID_PREFIX_RE = /^(\d{6,})_/;

/**
 * Names that are map-side / style-layer / promo entries, not real firm
 * cards. Mirrors `JUNK_NAME_PATTERNS` in `mapper.ts` — duplicated here
 * so the discovery helper stays independent of the mapper module (the
 * user-facing constraint keeps the mapper untouched). Kept in sync
 * manually; if a new junk pattern is added to `mapper.ts`, mirror it
 * here. Names are tested case-insensitively, just like the mapper.
 *
 * Note on character classes: the patterns below use
 * `[\wа-яёА-ЯЁ]` rather than the bare `\w` shortcut because
 * JavaScript's `\w` matches only `[A-Za-z0-9_]`, *not* Cyrillic
 * letters. Bare `\w` in the mapper's original patterns silently
 * fails to match the Russian affixes the patterns are written
 * against — the unit tests never exposed it because the test
 * fixtures use ASCII names. The discovery helper needs the
 * patterns to *actually work* against real 2GIS payloads, so
 * Cyrillic is added explicitly here.
 */
const MARKER_JUNK_NAME_PATTERNS: RegExp[] = [
  /^\s*\[[^\]]+\]/, // bracketed style / layer label, e.g. "[light] …"
  /статичн[\wа-яёА-ЯЁ]*\s+текстур/i,
  /\bтекстур[аыуео]?\b/i,
  /глобальн[\wа-яёА-ЯЁ]*\s+карт/i,
  /данн[\wа-яёА-ЯЁ]*\s+и\s+технолог[\wа-яёА-ЯЁ]*.*бизнес/i,
  /2\s?гис.*для\s+бизнеса/i
];

/**
 * Extract the leading-numeric firm id from a `markers/clustered`
 * composite id. Returns `null` when the id does not start with a long
 * numeric run followed by `_` — that means the row is a map style
 * layer, a global map record, or some other non-firm entry that the
 * mapper would also reject.
 */
export function markerIdToFirmId(compositeId: string): string | null {
  if (!compositeId) return null;
  const match = compositeId.match(MARKER_FIRM_ID_PREFIX_RE);
  return match ? match[1] : null;
}

/**
 * True when a `markers/clustered` item should be skipped:
 *  - `is_advertising === true` (2GIS marks paid placements explicitly);
 *  - `has_ads_model === true` (the item carries an `ads` block — also a
 *    paid placement, surfaced in the side panel as a sponsored card);
 *  - `cluster.count > 1` (the item is a *group* of firms at the same
 *    pin, not a single firm — the cluster count means there is no
 *    individual id to record).
 *
 * The mapper's full `looksLikeFirm` chain rejects all of these for
 * different reasons; we mirror the outcome here so the synthesis
 * behaves consistently with the primary path's view of what counts as
 * a firm.
 */
function isAdvertisingMarker(item: Record<string, unknown>): boolean {
  if (item.is_advertising === true) return true;
  if (item.has_ads_model === true) return true;
  const cluster = item.cluster;
  if (cluster && typeof cluster === "object" && (cluster as Record<string, unknown>).count &&
      typeof (cluster as Record<string, unknown>).count === "number" &&
      ((cluster as Record<string, unknown>).count as number) > 1) {
    return true;
  }
  return false;
}

/**
 * Synthesize firm candidates from a single `markers/clustered` response.
 * The strict mapper in `mapper.ts` rejects these payloads on two
 * grounds: the composite-id format (the long-numeric prefix is
 * followed by a hash) and the absence of full firm context fields
 * (address_name, contact_groups, etc.) — map markers carry only the
 * map-side fields. The hybrid path keeps the mapper untouched and
 * runs this narrower synthesis instead, applying the same junk-name
 * patterns and rejecting ad / cluster rows.
 *
 * Returns a `FirmCardCandidate[]` (the same shape the DOM path
 * produces) so the orchestrator can merge the result directly with
 * `mergeCandidates`. The `category` and `city` parameters are kept
 * for symmetry with `mapRawCard`, but they are intentionally not
 * stored on the candidate — the orchestrator applies them when it
 * maps the merged list to `RawCompanyCard` at the end.
 *
 * Order is preserved: the first occurrence of any given firm id
 * wins. Pure so the unit tests can pin behaviour without a live
 * browser. Returns an empty array when the payload has no
 * `result.items` array or no item survives the filters.
 */
export function synthesizeCardsFromMarkersPayload(
  payload: unknown,
  category: string,
  city: string
): FirmCardCandidate[] {
  void category;
  void city;
  if (!payload || typeof payload !== "object") return [];
  const top = payload as Record<string, unknown>;
  const result = top.result;
  if (!result || typeof result !== "object") return [];
  const items = (result as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const out: FirmCardCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (isAdvertisingMarker(rec)) continue;
    const compositeId = typeof rec.id === "string" ? rec.id : "";
    const firmId = markerIdToFirmId(compositeId);
    if (!firmId) continue;
    if (seen.has(firmId)) continue;
    const name = typeof rec.name === "string" ? rec.name.replace(/\s+/g, " ").trim() : "";
    if (!name) continue;
    if (MARKER_JUNK_NAME_PATTERNS.some((re) => re.test(name))) continue;
    seen.add(firmId);
    // Markers carry no per-firm /firm/<id> href in their payload, so
    // `url` is left empty. The orchestrator maps the final merged
    // list to `RawCompanyCard` with `url: c.url`, so an empty string
    // is the right sentinel — detail extraction falls back to
    // building the canonical /firm/<id> URL from `externalId` when
    // this is empty.
    out.push({
      externalId: firmId,
      name,
      url: ""
    });
  }
  return out;
}

/**
 * Scroll the 2GIS results panel and collect firm cards until one of the
 * agreed stop conditions trips. Returns the collected cards (capped at
 * `query.limit`) plus diagnostics. Anti-bot detections raised by
 * `opts.detectCaptcha` propagate up the call stack so the adapter
 * records a captcha/blocked event and the run fails loudly.
 *
 * Hybrid supplement: if `opts.markersPayloads` is provided and the
 * DOM scroll-and-collect loop ends below `query.limit`, the
 * orchestrator runs {@link synthesizeCardsFromMarkersPayload} on each
 * payload and merges the resulting cards (deduped by `externalId`).
 * The synthesis is strictly additive — it never replaces DOM-collected
 * cards and it only runs after the loop terminates normally.
 */
export async function collectFirmCardsViaScroll(
  page: Page,
  query: SearchQuery,
  opts: DomFallbackOptions = {}
): Promise<{ cards: RawCompanyCard[]; telemetry: DomFallbackTelemetry }> {
  const target = Math.max(1, query.limit);
  const maxScrollAttempts = opts.maxScrollAttempts ?? 60;
  const noNewCardThreshold = opts.noNewCardThreshold ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const delayRangeMs = opts.delayRangeMs ?? [800, 1600];
  const deadlineMs = Date.now() + timeoutMs;
  const detectCaptcha = opts.detectCaptcha;

  let collected: FirmCardCandidate[] = [];
  let duplicates = 0;
  let scrollAttempts = 0;
  let stagnant = 0;
  let loadMoreClicks = 0;
  const perStep: number[] = [];
  const scrollProbes: ScrollProbe[] = [];

  // Initial pass — collect whatever is already rendered before any scroll.
  // The first probe records the initial panel metrics (moved=false).
  {
    const initialProbe = await page.evaluate((): ScrollProbe => {
      const anchors = document.querySelectorAll("a[href*='/firm/']");
      if (anchors.length === 0) {
        return {
          strategy: "no_anchors",
          scrollTop: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: window.innerHeight,
          moved: false
        };
      }
      let n: Element | null = anchors[0].parentElement;
      while (n) {
        const cs = window.getComputedStyle(n);
        const oy = cs.overflowY;
        if ((oy === "auto" || oy === "scroll" || oy === "overlay") &&
            (n as HTMLElement).scrollHeight > (n as HTMLElement).clientHeight + 1) {
          const el = n as HTMLElement;
          return {
            strategy: "panel",
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            moved: false
          };
        }
        n = n.parentElement;
      }
      return {
        strategy: "scrollIntoView",
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: window.innerHeight,
        moved: false
      };
    });
    scrollProbes.push(initialProbe);

    const anchors = await collectFirmAnchors(page);
    const batch = selectFirmCardCandidates(anchors);
    const result = mergeCandidates(collected, batch);
    collected = result.merged;
    duplicates += result.duplicates;
    perStep.push(result.added);
  }

  let stopReason: StopReason = "max_scrolls";
  while (true) {
    const decision = evaluateStopCondition({
      collected: collected.length,
      limit: target,
      scrollAttempts,
      maxScrollAttempts,
      consecutiveStagnantScrolls: stagnant,
      noNewCardThreshold,
      deadlineMs,
      nowMs: Date.now(),
      softBlockDetected: false,
      captchaDetected: false
    });
    if (decision.stop && decision.reason) {
      stopReason = decision.reason;
      break;
    }

    const probe = await scrollResultsPanel(page);
    scrollAttempts += 1;
    scrollProbes.push(probe);
    await page.waitForTimeout(randomDelay(delayRangeMs));

    // CAPTCHA / wall probe between scrolls — re-using the adapter's own
    // detector means any wall surfaces with the same evidence and
    // screenshot pipeline as the rest of the run, so this path never
    // weakens the existing detection guarantee.
    if (detectCaptcha) {
      await detectCaptcha(page);
    }

    const anchors = await collectFirmAnchors(page);
    const batch = selectFirmCardCandidates(anchors);
    const result = mergeCandidates(collected, batch);
    const added = result.added;
    collected = result.merged;
    duplicates += result.duplicates;
    perStep.push(added);
    if (added === 0) stagnant += 1;
    else stagnant = 0;

    // If the panel did not actually move and we are accumulating
    // stagnant steps, try a "load more" button click before giving up
    // on this scroll. This is the only strategy that can grow the
    // results list when the page caps virtual scrolling and exposes a
    // manual "Показать ещё" / "Load more" control.
    if (stagnant > 0 && !probe.moved && loadMoreClicks < 3) {
      const clicked = await clickLoadMoreButton(page);
      if (clicked) {
        loadMoreClicks += 1;
        scrollProbes.push({
          strategy: "load_more",
          scrollTop: probe.scrollTop,
          scrollHeight: probe.scrollHeight,
          clientHeight: probe.clientHeight,
          moved: true
        });
        await page.waitForTimeout(randomDelay(delayRangeMs));
      }
    }

    // Soft-block probe: only checks the visible page text against the
    // existing classifier. No payload evidence is required because the
    // DOM fallback path is taken precisely when no API payloads were
    // captured; the text-only signal still flags an "empty results"
    // wall, which is the case worth stopping for.
    const bodyText = await readBodyText(page);
    const softBlock = classifySoftBlock(bodyText, []);
    if (softBlock) {
      stopReason = "soft_blocked";
      break;
    }
  }

  // Hybrid supplement: when the DOM scroll-and-collect path finishes
  // below the target, fall back to the `markers/clustered` payloads
  // captured by the adapter's separate listener. The synthesis
  // applies the same junk-name filter as the mapper, rejects ad /
  // cluster markers, and dedupes against the DOM-collected set by
  // `externalId`. It runs strictly after the loop so the loop's
  // stop-reason telemetry stays meaningful (a `no_new_cards` outcome
  // is not silently masked by the supplement).
  const markersPayloads = opts.markersPayloads ?? [];
  let markersSynthesized = 0;
  let markersRejected = 0;
  if (markersPayloads.length > 0 && collected.length < target) {
    for (const payload of markersPayloads) {
      const synthesized = synthesizeCardsFromMarkersPayload(
        payload,
        query.category,
        query.geo
      );
      const merged = mergeCandidates(collected, synthesized);
      markersSynthesized += merged.added;
      // Anything in the synthesized batch that did not make it into
      // the merged set is by definition a duplicate of an existing
      // `externalId`; we count it as `markersRejected` so the total
      // seen vs total kept stays auditable.
      markersRejected += synthesized.length - merged.added;
      collected = merged.merged;
      if (collected.length >= target) break;
    }
  }

  const cards: RawCompanyCard[] = collected.slice(0, target).map((c) => ({
    source: "2gis",
    externalId: c.externalId,
    name: c.name,
    category: query.category,
    city: query.geo,
    address: "",
    url: c.url,
    payload: { href: c.url, text: c.name }
  }));

  const telemetry: DomFallbackTelemetry = {
    collected: cards.length,
    duplicates,
    scrollAttempts,
    perStep,
    stopReason,
    scrollProbes,
    markersSynthesized,
    markersRejected
  };

  logger.info("2gis dom fallback scroll summary", {
    target,
    collected: telemetry.collected,
    duplicates: telemetry.duplicates,
    scrollAttempts: telemetry.scrollAttempts,
    stopReason: telemetry.stopReason,
    perStepSample: perStep.slice(0, 20),
    scrollProbeSample: scrollProbes.slice(0, 20).map((p) => ({
      strategy: p.strategy,
      scrollTop: p.scrollTop,
      scrollHeight: p.scrollHeight,
      clientHeight: p.clientHeight,
      moved: p.moved
    })),
    loadMoreClicks,
    markersPayloadsSeen: markersPayloads.length,
    markersSynthesized,
    markersRejected
  });

  return { cards, telemetry };
}
