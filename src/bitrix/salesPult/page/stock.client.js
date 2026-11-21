// Склад 1С на карточках Радара и в строках открытых планов: только штуки, без цен.
// Сопоставление считает сервер (src/bitrix/salesPult/stock/availability.ts) и кладёт в PAYLOAD.stock.hints
// готовые подсказки по ID сделок; здесь — только тег.
(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const ddmm = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
  const ddmmyyyy = (iso) => (ddmm(iso) ? `${ddmm(iso)}.${iso.slice(0, 4)}` : "");

  let indexed = null;
  let index = new Map();
  function hintFor(stock, id) {
    if (indexed !== stock) {
      indexed = stock;
      index = new Map();
      for (const hint of Array.isArray(stock.hints) ? stock.hints : []) {
        for (const dealId of Array.isArray(hint.ids) ? hint.ids : []) index.set(String(dealId), hint);
      }
    }
    return index.get(String(id));
  }

  /** Тег «склад: 69 шт · 75″» для карточки или плана; склада нет или неизвестен — пустая строка. */
  window.__stockHint = function (item) {
    const stock = typeof PAYLOAD === "undefined" ? null : PAYLOAD?.stock;
    if (!stock || !item) return "";
    const hint = hintFor(stock, item.id);
    if (!hint || !(hint.qty > 0)) return "";
    const need = Number(item.qty) || 0;
    const cls = hint.approx ? "approx" : need > hint.qty ? "warn" : "good";
    const parts = [`склад: ${nf0.format(hint.qty)} шт`];
    if (hint.diagonal) parts.push(`${hint.diagonal}″`);
    if (hint.approx) parts.push("≈ по виду");
    if (stock.stale && ddmm(stock.asOf)) parts.push(`на ${ddmm(stock.asOf)}`);
    const status = cls === "approx" ? "приблизительно: итог по виду товара, модель и диагональ не сверены"
      : cls === "warn" ? `меньше, чем в закупке (${nf0.format(need)} шт)`
        : "хватает на закупку";
    const title = `Склад 1С${ddmmyyyy(stock.asOf) ? ` на ${ddmmyyyy(stock.asOf)}` : ""}: только штуки, без цен. ${status[0].toUpperCase()}${status.slice(1)}.`;
    return `<span class="tag stock-tag ${cls}" title="${esc(title)}">${esc(parts.join(" · "))}<span class="stock-sr">, ${esc(status)}</span></span>`;
  };
})();
