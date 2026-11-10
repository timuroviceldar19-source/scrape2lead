// Bootstrap runner for standalone reg.html
(function () {
  "use strict";

  const P = typeof PAYLOAD !== "undefined" ? PAYLOAD : {};
  const R = P.register;
  const regEl = document.getElementById("tab-reg");

  function animate(root) {
    if (!root) return;
    root.querySelectorAll("[data-w]").forEach((b) => { b.style.width = b.dataset.w + "%"; });
    root.querySelectorAll("[data-h]").forEach((b) => { b.style.height = b.dataset.h + "%"; });
  }

  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          animate(e.target);
          io.unobserve(e.target);
        }
      }), { threshold: 0.08 })
    : null;

  function observe() {
    document.querySelectorAll(".reveal:not(.in)").forEach((s) => {
      if (io) io.observe(s);
      else {
        s.classList.add("in");
        animate(s);
      }
    });
  }

  const months = window.__registerMonths(R);
  const picker = document.getElementById("registerMonths");
  const buttons = new Map();
  if (picker) {
    for (const month of months) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.month = month;
      button.textContent = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" })
        .format(new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1)).replace(/ г\.$/, "");
      button.textContent = button.textContent[0].toUpperCase() + button.textContent.slice(1);
      button.addEventListener("click", () => {
        if (location.hash !== `#${month}`) location.hash = month;
        renderMonth();
      });
      picker.appendChild(button);
      buttons.set(month, button);
    }
  }

  let renderedMonth;
  let rendered = false;
  function renderMonth() {
    const requested = location.hash.slice(1);
    const selected = months.includes(requested) ? requested : R?.month || months[0];
    if (rendered && renderedMonth === selected) return;
    rendered = true;
    renderedMonth = selected;
    const activeView = window.__registerViewForMonth(R, selected);
    window.__renderRegisterTab(activeView, regEl, selected === P.asOfDate?.slice(0, 7) ? (P.reconciliation || { closedNotInRegister: [], possibleDuplicates: [] }) : null, P.portal);
    buttons.forEach((button, month) => button.setAttribute("aria-pressed", String(month === selected)));
    const dateLabel = document.getElementById("dateLabel");
    if (dateLabel) dateLabel.textContent = `Данные на ${activeView?.asOf || P.asOfDate || ""}`;
    const srcLabel = document.getElementById("srcLabel");
    if (srcLabel) srcLabel.textContent = activeView?.file ? `${activeView.file} · Диск Битрикс24` : "";
    const footSource = document.getElementById("footSource");
    if (footSource && activeView?.file) footSource.textContent = `Источник: реестр РОПа «${activeView.file}», папка «Реестр ОП» на Диске Битрикс24 · сверка со сделками Битрикс24`;
    animate(regEl);
    observe();
  }
  addEventListener("hashchange", renderMonth);
  renderMonth();
  const liveText = document.getElementById("liveText");
  if (liveText && P.generatedAt) liveText.textContent = P.generatedAt;

  function moveInd() {
    const secInd = document.querySelector(".sections .ind");
    const activeLink = document.querySelector(".sections a[aria-current='page']");
    if (secInd && activeLink) {
      secInd.style.left = activeLink.offsetLeft + 14 + "px";
      secInd.style.width = activeLink.offsetWidth - 28 + "px";
    }
  }

  addEventListener("resize", moveInd);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(moveInd);
  }
  setTimeout(moveInd, 0);

  document.addEventListener("click", (e) => {
    const row = e.target.closest(".r.body[role='button']");
    if (row) {
      const open = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(open));
      if (row.nextElementSibling) row.nextElementSibling.classList.toggle("open", open);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches(".r.body[role='button']")) {
      e.target.click();
    }
  });
})();
