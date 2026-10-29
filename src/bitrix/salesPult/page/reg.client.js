// Bootstrap runner for standalone reg.html
(function () {
  "use strict";

  const P = typeof PAYLOAD !== "undefined" ? PAYLOAD : {};
  const R = P.register;
  const regEl = document.getElementById("tab-reg");

  if (window.__renderRegisterTab) {
    window.__renderRegisterTab(R, regEl);
  }

  const dateLabel = document.getElementById("dateLabel");
  if (dateLabel) {
    dateLabel.textContent = `Данные на ${R?.asOf || P.asOfDate || ""}`;
  }

  const srcLabel = document.getElementById("srcLabel");
  if (srcLabel && R?.file) {
    srcLabel.textContent = `${R.file} · Диск Битрикс24`;
  }

  const liveText = document.getElementById("liveText");
  if (liveText && P.generatedAt) {
    liveText.textContent = P.generatedAt;
  }

  const footSource = document.getElementById("footSource");
  if (footSource && R?.file) {
    footSource.textContent = `Источник: реестр РОПа «${R.file}», папка «Реестр ОП» на Диске Битрикс24 · сверка со сделками Битрикс24`;
  }

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
    const row = e.target.closest(".mgr .r.body");
    if (row) {
      const open = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(open));
      if (row.nextElementSibling) row.nextElementSibling.classList.toggle("open", open);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches(".mgr .r.body")) {
      e.target.click();
    }
  });
})();
