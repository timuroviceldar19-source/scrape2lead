// Client-side rendering for "Рынок ИП" and "Рынок КТ" tabs
(function () {
  "use strict";

  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const MONTHS_S = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt = (n) => nf0.format(Math.round(n || 0));
  const mln = (n) => nf1.format((n || 0) / 1e6);
  const money = (n) => `${mln(n)} млн ₸`;
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;
  const pct1 = (x) => `${nf1.format((x || 0) * 100)}%`;
  const plural = (n, f) => {
    const a = Math.abs(n) % 100, b = a % 10;
    const w = a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b > 1 && b < 5 ? f[1] : f[2];
    return `${fmt(n)} ${w}`;
  };
  const ddmm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const short = (s, n = 70) => {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const head = (idx, title, meta = "") => `<div class="block-head"><h2><span class="idx">${idx}</span>${title}</h2><span class="meta">${meta}</span></div>`;
  const bar = (w, cls = "", tick) => `<div class="hbar"><span class="${cls}" data-w="${Math.max(0, Math.min(100, w)).toFixed(1)}"></span>${tick != null ? `<i style="left:${Math.min(100, tick)}%"></i>` : ""}</div>`;

  window.__renderMarketTab = function (key, MK, el) {
    if (!el) return;
    const isIp = key === "ip" || key === "ИП";
    const V = isIp ? (MK?.ip || MK?.["ИП"]) : (MK?.kt || MK?.["КТ"]);
    if (!V) {
      el.innerHTML = `<section class="block"><p class="lead">${esc(MK?.error || "Данные рынка ещё собираются.")}</p></section>`;
      return;
    }

    const title = isIp ? "интерактивных панелей" : "компьютерной техники";
    const M = Number(V.month.slice(5, 7));
    const delta = V.prev.sum ? V.total.sum / V.prev.sum - 1 : 0;
    const second = V.suppliers.find((x) => !x.us) ?? { name: "—", sum: 0 };
    const leader = V.suppliers[0] ?? { name: "—", sum: 0 };
    const verdict = V.us.rank === 1
      ? `Мы первые: <b>${money(V.us.sum)}</b>, у второго места (${esc(short(second.name, 40))}) ${money(second.sum)}.`
      : `Мы на <b>${V.us.rank || "—"}-м месте</b> с ${money(V.us.sum)}. Лидер — ${esc(short(leader.name, 40))}: ${money(leader.sum)}, это ${pct1(V.total.sum ? leader.sum / V.total.sum : 0)} рынка.`;

    const isStale = Boolean(MK?.stale || (MK?.updatedAt && MK?.asOf && MK.updatedAt < MK.asOf));
    const staleWarning = isStale
      ? `<div class="note-warn">Данные рынка не обновлены с ${ddmm(MK.updatedAt)}</div>`
      : "";

    let s = `${staleWarning}<section class="block reveal">${head("01", `Рынок ${title} · ${MONTHS[M - 1]}`, "госзакупки, все каналы · без НДС")}
    <div class="hero"><div>
      <span class="label">Объём рынка</span>
      <div class="hero-num"><span class="big">${fmt(V.total.sum / 1e6)}</span><span class="of">млн ₸</span></div>
      <div class="hero-amt">${plural(V.total.contracts, ["договор", "договора", "договоров"])} <span class="muted">· ${plural(V.total.suppliers, ["поставщик", "поставщика", "поставщиков"])}</span></div>
      <div class="readout">
        <div><span class="label">Наша доля</span><div class="v">${pct1(V.us.share)}<small> · ${mln(V.us.sum)} млн</small></div></div>
        <div><span class="label">Наше место</span><div class="v">${V.us.rank || "—"}<small> из ${V.total.suppliers}</small></div></div>
        <div><span class="label">К 1–${Number(V.prev.toDay)} ${MONTHS_S[M >= 2 ? M - 2 : 11]}</span><div class="v ${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta * 100))}%<small> рынок</small></div></div>
      </div>
      <p class="verdict">${verdict}</p>
    </div><div><div class="share rows"><div class="r head"><span></span><span class="label">Поставщик</span><span class="label">Доля рынка</span><span class="label">Сумма</span><span class="label">Дог.</span></div>
      ${V.suppliers.slice(0, 10).map((x, i) => `<div class="r${x.us ? " us" : ""}"><span class="rk">${i + 1}</span><span class="nm" title="${esc(x.name)}">${esc(short(x.name.replace(/^Товарищество с ограниченной ответственностью/i, "ТОО"), 44))}</span>${bar(V.suppliers[0]?.sum ? x.sum / V.suppliers[0].sum * 100 : 0, x.us ? "ink" : "")}<span class="num">${mln(x.sum)} млн</span><span class="num">${x.contracts}</span></div>`).join("")}
      <div class="r"><span></span><span class="dim">Остальные ${Math.max(0, V.total.suppliers - 10)}</span><span></span><span class="num">${mln(V.othersSum + V.suppliers.slice(10).reduce((a, x) => a + x.sum, 0))} млн</span><span></span></div>
    </div></div></div></section>`;

    // 02 По месяцам
    const months = V.months.filter((m) => m.m >= "2026-01");
    const mMax = months.length ? Math.max(...months.map((m) => m.sum)) : 1;
    const toDayNum = V.prev?.toDay ? Number(V.prev.toDay) : null;

    s += `<section class="block reveal">${head("02", "По месяцам", "весь рынок · наша часть тёмным")}
    <div class="months">${months.map((m) => {
      const desktopLab = fmt(m.sum / 1e6);
      const mobileLab = (!isIp && m.sum >= 1e9) ? nf1.format(m.sum / 1e9) : desktopLab;
      return `<div class="col" title="${MONTHS[Number(m.m.slice(5)) - 1]}: рынок ${money(m.sum)}, мы ${money(m.us)}"><div class="tot" data-h="${(m.sum / mMax * 100).toFixed(1)}"><span class="lab"><span class="desktop">${desktopLab}</span><span class="mobile">${mobileLab}</span></span><div class="our" data-h="${(m.sum ? m.us / m.sum * 100 : 0).toFixed(1)}"></div></div></div>`;
    }).join("")}</div>
    <div class="mlabels">${months.map((m) => {
      const isCurrent = m.m === V.month;
      const mName = isCurrent && toDayNum ? `${MONTHS_S[Number(m.m.slice(5)) - 1]} · по ${toDayNum}` : MONTHS_S[Number(m.m.slice(5)) - 1];
      const mPct = pct(m.sum ? m.us / m.sum : 0);
      return `<span><span class="m-name">${mName}</span><span class="m-pct">${mPct}</span></span>`;
    }).join("")}</div>
    <p class="note-src" style="margin-top: 10px; font-size: 11px;">* До июня 2026 года договоров F3 на портале госзакупок нет.</p></section>`;

    // 03 Каналы и цены
    const big = V.methods[0] ?? { name: "—", sum: 0, us: 0 };
    const best = [...V.methods].filter((x) => x.sum > V.total.sum * 0.05).sort((x, y) => (y.us / y.sum) - (x.us / x.sum))[0] ?? big;
    const chLead = big === best
      ? `Больше всего денег в канале «${esc(big.name)}»: ${money(big.sum)}, и здесь же наша самая большая доля — ${pct(big.sum ? big.us / big.sum : 0)}.`
      : `Больше всего денег в канале «${esc(big.name)}»: ${money(big.sum)}, наша доля там <b>${pct(big.sum ? big.us / big.sum : 0)}</b>. Сильнее всего мы в канале «${esc(best.name)}»: ${pct(best.sum ? best.us / best.sum : 0)}.`;

    s += `<section class="block reveal">${head("03", "Каналы и цены", `${MONTHS[M - 1]}`)}<p class="lead">${chLead}</p><div class="two">
    <div><div class="sub-h"><h3>Как покупают</h3><span class="label">рынок · наша доля</span></div><div class="meth rows">
      ${V.methods.map((x) => `<div class="r"><span>${esc(x.name)} <span class="dim">${x.contracts}</span></span>${bar(V.methods[0]?.sum ? x.sum / V.methods[0].sum * 100 : 0, "", null)}<span class="num">${mln(x.sum)} млн</span><span class="num">${pct(x.sum ? x.us / x.sum : 0)}</span></div>`).join("")}</div></div>
    <div><div class="sub-h"><h3>Цена за штуку</h3><span class="label">полоса — средние 50% рынка, ● — наша</span></div><div class="price rows">
      ${V.kinds.map((k) => {
        const hi = Math.max(k.p75, k.usMed || 0) * 1.15 || 1;
        const X = (v) => (v / hi * 100).toFixed(1);
        return `<div class="r"><span>${esc(k.kind)} <span class="dim">${plural(Math.round(k.qty), ["шт", "шт", "шт"])}</span></span><div class="range"><span class="ax"></span><span class="iqr" style="left:${X(k.p25)}%;width:${(Number(X(k.p75)) - Number(X(k.p25))).toFixed(1)}%"></span><span class="med" style="left:${X(k.med)}%"></span>${k.usMed ? `<span class="usm" style="left:${X(k.usMed)}%"></span>` : ""}</div><span class="num">${fmt(k.med)} <span class="dim">₸ рынок</span></span><span class="num">${k.usMed ? fmt(k.usMed) : "—"} <span class="dim">₸ мы</span></span></div>`;
      }).join("")}</div></div>
  </div></section>`;

    // 04 Крупные договоры не у нас
    s += `<section class="block reveal">${head("04", "Крупные договоры не у нас", `${MONTHS[M - 1]} · топ-10 по сумме`)}<div class="lost rows">
    <div class="r head"><span class="label">Дата</span><span class="label">Заказчик</span><span class="label">Поставщик</span><span class="label">Товар</span><span class="label">Шт</span><span class="label">Сумма</span><span class="label">Канал</span></div>
    ${V.lost.map((x) => `<div class="r"><span class="num">${ddmm(x.date)}</span><span class="cust" title="${esc(x.customer)}">${esc(short(x.customer, 70))}</span><span class="cust" title="${esc(x.supplier)}">${esc(short(x.supplier.replace(/^Товарищество с ограниченной ответственностью/i, "ТОО"), 34))}</span><span>${esc(x.kind)}</span><span class="num">${fmt(x.qty)}</span><span class="num">${mln(x.sum)} млн</span><span class="dim">${esc(x.method)}</span></div>`).join("")}</div></section>`;

    // 05 Крупнейшие заказчики
    s += `<section class="block reveal">${head("05", "Крупнейшие заказчики", `${MONTHS[M - 1]} · наша доля у каждого`)}<div class="cust rows">
    <div class="r head"><span class="label">Заказчик</span><span class="label">Купил</span><span class="label">Дог.</span><span class="label">У нас</span></div>
    ${V.customers.map((x) => `<div class="r"><span class="cust" title="${esc(x.name)}">${esc(short(x.name, 100))}</span><span class="num">${mln(x.sum)} млн</span><span class="num">${x.contracts}</span><div>${bar(x.sum ? x.us / x.sum * 100 : 0, "ink")}<span class="dim">${x.us ? money(x.us) : "ничего"}</span></div></div>`).join("")}</div>
    <p class="note-src">Договоры госзакупок по дате подписания, все способы закупки, включая электронный магазин. Суммы позиций без НДС. Расторгнутые и заменённые доп. соглашением версии не считаются. ${isIp ? "Коды ЕНС ТРУ: 262030.100.000021 панель интерактивная, 262030.100.000043 доска интерактивная, 262030.100.000011/13 система мультимедийная." : "Коды ЕНС ТРУ: компьютеры 262013.000.000011/12, системные блоки 262040.000.000267/268, ноутбуки 262011.100.*, МФУ 262018.900.*, принтеры 262016.300.000015–19, мониторы 262017.100.*."}</p></section>`;

    el.innerHTML = s;
  };
})();
