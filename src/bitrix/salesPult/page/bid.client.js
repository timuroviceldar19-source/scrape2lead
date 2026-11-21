// Рисует вердикт «идём / осторожно / не идём» и подсказки «как выиграть» у карточек Радара и открытых планов.
// Считает всё сервер (src/bitrix/salesPult/bid/assess.ts): здесь только разметка из item.bid.
(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n || 0);
  const LABELS = { go: "идём", caution: "осторожно", nogo: "не идём" };
  const EMPTY = { verdictHtml: "", customerHtml: "", priceHtml: "", risk: false, hasVerdict: false };

  window.__bidHtml = function (bid) {
    if (!bid || typeof bid !== "object") return EMPTY;
    const reasons = Array.isArray(bid.reasons) ? bid.reasons : [];
    const tags = reasons.filter(r => r.kind !== "price")
      .map(r => `<span class="tag ${r.tone === "good" ? "good" : "warn"}"${r.title ? ` title="${esc(r.title)}"` : ""}>${esc(r.text)}</span>`).join("");
    const label = LABELS[bid.verdict] || "";
    const why = reasons.map(r => r.text).join("; ");
    const p = bid.price;
    const statusText = p && p.status === "good" ? "запас" : p && p.status === "bad" ? "низкая цена" : "";
    return {
      verdictHtml: label ? `<span class="bid-verdict ${esc(bid.verdict)}" title="${esc(`Вердикт: ${label}${why ? `. ${why}` : ""}`)}">${label}</span>` : "",
      customerHtml: tags ? `<span class="win-hints">${tags}</span>` : "",
      priceHtml: p ? `<span class="win-price ${p.status === "good" || p.status === "bad" ? p.status : ""}">~${fmt(p.unit)}/шт · победы ~${fmt(p.winMedian)}${statusText ? ` · ${statusText}` : ""}</span>` : "",
      // «Риск ТС / конкурента»: конкурент забирал заказчика или ТС похоже на шаблон, где побеждал конкурент
      risk: reasons.some(r => r.kind === "rival" || (r.kind === "template" && r.tone !== "good")),
      hasVerdict: Boolean(label)
    };
  };
})();
