"use strict";

(function () {
  var TOKEN_KEY = "s2l_operator_token";
  var BASE = "/api/v1";

  var state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    jobs: [],
    jobsTotal: 0,
    jobsFilter: { status: "", limit: 20, offset: 0 },
    selectedJobId: null,
    job: null,
    logs: { items: [], total: 0, limit: 200, offset: 0, maxLogLines: 0 },
    artifacts: [],
    artifactsSource: "",
    perJobArtifacts: [],
    health: { status: "unknown", detail: null },
    inFlight: 0
  };

  // --- DOM cache ---
  var el = function (id) { return document.getElementById(id); };
  var tokenInput = el("token");
  var healthBtn = el("btn-health");
  var healthPill = el("health-pill");
  var alertEl = el("alert");
  var jobsBody = el("jobs-body");
  var jobsTotalEl = el("jobs-total");
  var jobsStatus = el("jobs-status");
  var jobsLimit = el("jobs-limit");
  var jobsOffset = el("jobs-offset");
  var detailEmpty = el("detail-empty");
  var detailBody = el("detail-body");
  var logsEl = el("logs");
  var logsLimit = el("logs-limit");
  var logsOffset = el("logs-offset");
  var logsMeta = el("logs-meta");
  var perjobList = el("perjob-list");
  var perjobMeta = el("perjob-meta");
  var artifactsList = el("artifacts-list");
  var artifactsMeta = el("artifacts-meta");
  var submitForm = el("submit-form");
  var binsInput = el("bins");
  var skipStat = el("skipStat");
  var skipTenders = el("skipTenders");
  var skipZakup = el("skipZakup");
  var skipGoszakupRegistry = el("skipGoszakupRegistry");
  var registryOnly = el("registryOnly");
  var forceRefresh = el("forceRefresh");
  var delayMs = el("delayMs");
  var goszakupMaxPages = el("goszakupMaxPages");
  var cancelBtn = el("btn-cancel");

  // --- helpers ---
  function tokenHeader() {
    return state.token ? { Authorization: "Bearer " + state.token } : {};
  }

  function showAlert(message) {
    if (!message) {
      alertEl.classList.add("hidden");
      alertEl.textContent = "";
      return;
    }
    alertEl.classList.remove("hidden");
    alertEl.textContent = message;
  }

  function fmtDate(value) {
    if (!value) return "";
    var d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toISOString().replace("T", " ").slice(0, 19);
  }

  function shortId(id) {
    if (!id) return "";
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  function setBusy(busy) {
    state.inFlight += busy ? 1 : -1;
    if (state.inFlight < 0) state.inFlight = 0;
    applyButtonStates();
  }

  function applyButtonStates() {
    var busy = state.inFlight > 0;
    var buttons = document.querySelectorAll("button[data-action]");
    for (var i = 0; i < buttons.length; i++) {
      // Health button has its own id, but uses data-action too. Disable all during in-flight.
      buttons[i].disabled = busy;
    }
    // Cancel is also disabled for terminal jobs, independent of in-flight state.
    if (cancelBtn && state.job) {
      var terminal = !(state.job.status === "queued" || state.job.status === "running");
      cancelBtn.disabled = busy || terminal;
    }
  }

  function withBusy(fn) {
    setBusy(true);
    return Promise.resolve()
      .then(fn)
      .catch(function (err) {
        showAlert("Error: " + (err && err.message ? err.message : String(err)));
        throw err;
      })
      .finally(function () { setBusy(false); });
  }

  function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, tokenHeader(), options.headers || {});
    return fetch(BASE + path, Object.assign({}, options, { headers: headers }))
      .then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          if (text) {
            try { json = JSON.parse(text); } catch (e) { json = null; }
          }
          if (!res.ok) {
            var msg = (json && (json.message || json.error)) || ("HTTP " + res.status);
            var err = new Error(msg);
            err.status = res.status;
            err.body = json;
            throw err;
          }
          return json;
        });
      });
  }

  // --- actions ---
  function checkHealth() {
    return withBusy(function () {
      return fetch("/health", { headers: tokenHeader() }).then(function (res) {
        state.health.status = res.ok ? "ok" : "bad";
        return res.text().then(function (text) {
          try { state.health.detail = JSON.parse(text); } catch (e) { state.health.detail = null; }
          renderHealth();
          if (!res.ok) {
            var msg = "Health check failed: HTTP " + res.status;
            if (res.status === 401) msg = "Health check failed: unauthorized (check API token)";
            showAlert(msg);
          } else {
            showAlert("");
          }
        });
      }).catch(function (err) {
        state.health.status = "bad";
        renderHealth();
        showAlert("Health check failed: " + (err.message || err));
      });
    });
  }

  function loadJobs() {
    var filter = state.jobsFilter;
    var qs = [];
    if (filter.status) qs.push("status=" + encodeURIComponent(filter.status));
    qs.push("limit=" + encodeURIComponent(String(filter.limit)));
    qs.push("offset=" + encodeURIComponent(String(filter.offset)));
    return withBusy(function () {
      return api("/jobs?" + qs.join("&")).then(function (body) {
        state.jobs = body.jobs || [];
        state.jobsTotal = body.total || 0;
        renderJobs();
      });
    });
  }

  function selectJob(jobId) {
    if (!jobId) return Promise.resolve();
    state.selectedJobId = jobId;
    renderJobs();
    return loadDetail(jobId);
  }

  function loadDetail(jobId) {
    if (!jobId) return Promise.resolve();
    return withBusy(function () {
      return api("/jobs/" + encodeURIComponent(jobId) + "?logLimit=0").then(function (body) {
        state.job = body.job;
        state.logs.limit = 200;
        state.logs.offset = 0;
        logsLimit.value = "200";
        logsOffset.value = "0";
        renderDetail();
        return loadLogs();
      }).then(function () {
        return loadPerJobArtifacts();
      });
    });
  }

  function loadLogs() {
    if (!state.selectedJobId) return Promise.resolve();
    var limit = parseInt(logsLimit.value, 10);
    var offset = parseInt(logsOffset.value, 10);
    if (!isFinite(limit) || limit < 1) limit = 200;
    if (!isFinite(offset) || offset < 0) offset = 0;
    return withBusy(function () {
      return api("/jobs/" + encodeURIComponent(state.selectedJobId) + "/logs?limit=" + limit + "&offset=" + offset)
        .then(function (body) {
          state.logs.items = body.logs || [];
          state.logs.total = body.total || 0;
          state.logs.limit = body.limit;
          state.logs.offset = body.offset;
          state.logs.maxLogLines = body.maxLogLines;
          renderLogs();
        });
    });
  }

  function cancelJob() {
    if (!state.selectedJobId) return Promise.resolve();
    if (!confirm("Cancel job " + shortId(state.selectedJobId) + "?")) return Promise.resolve();
    return withBusy(function () {
      return api("/jobs/" + encodeURIComponent(state.selectedJobId) + "/cancel", { method: "POST" })
        .then(function (body) {
          state.job = body.job;
          renderDetail();
          showAlert("Job cancelled");
          return loadJobs();
        });
    });
  }

  function loadArtifacts() {
    return withBusy(function () {
      return api("/artifacts").then(function (body) {
        state.artifacts = body.artifacts || [];
        state.artifactsSource = body.source || "";
        renderArtifacts();
      });
    });
  }

  function loadPerJobArtifacts() {
    if (!state.selectedJobId) return Promise.resolve();
    return withBusy(function () {
      return api("/jobs/" + encodeURIComponent(state.selectedJobId) + "/artifacts")
        .then(function (body) {
          state.perJobArtifacts = body.artifacts || [];
          renderPerJobArtifacts();
        });
    });
  }

  function submitJob(ev) {
    ev.preventDefault();
    var lines = binsInput.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var bins = [];
    var bad = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\d{12}$/.test(lines[i])) bins.push(lines[i]);
      else bad.push(lines[i]);
    }
    if (bins.length === 0) {
      showAlert("Provide at least one valid 12-digit BIN.");
      binsInput.focus();
      return Promise.resolve();
    }
    if (bad.length) {
      showAlert("Ignored " + bad.length + " invalid BIN(s) (must be 12 digits): " + bad.slice(0, 3).join(", "));
    }
    var body = { bins: bins };
    if (skipStat.checked) body.skipStat = true;
    if (skipTenders.checked) body.skipTenders = true;
    if (skipZakup.checked) body.skipZakup = true;
    if (skipGoszakupRegistry.checked) body.skipGoszakupRegistry = true;
    if (registryOnly.checked) body.registryOnly = true;
    if (forceRefresh.checked) body.forceRefresh = true;
    if (delayMs.value) body.delayMs = parseInt(delayMs.value, 10);
    if (goszakupMaxPages.value) body.goszakupMaxPages = parseInt(goszakupMaxPages.value, 10);
    return withBusy(function () {
      return api("/jobs/kz-enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (resp) {
          state.selectedJobId = resp.job.id;
          binsInput.value = "";
          showAlert("Submitted job " + shortId(resp.job.id));
          return loadJobs().then(function () { return loadDetail(resp.job.id); });
        });
    });
  }

  function downloadArtifact(artifact) {
    if (!artifact || artifact.id === undefined || artifact.id === null) return Promise.resolve();
    return withBusy(function () {
      return fetch(BASE + "/artifacts/" + artifact.id, { headers: tokenHeader() })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (text) {
              var msg = "HTTP " + res.status;
              try { var j = JSON.parse(text); msg = (j.message || j.error || msg); } catch (e) { /* keep status */ }
              throw new Error("Download failed: " + msg);
            });
          }
          return res.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = artifact.name || ("artifact-" + artifact.id);
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          });
        });
    });
  }

  // --- render ---
  function renderHealth() {
    var pill = healthPill;
    pill.classList.remove("pill-ok", "pill-bad", "pill-unknown");
    if (state.health.status === "ok") {
      pill.classList.add("pill-ok");
      pill.textContent = "ok";
      pill.title = state.health.detail ? JSON.stringify(state.health.detail) : "healthy";
    } else if (state.health.status === "bad") {
      pill.classList.add("pill-bad");
      pill.textContent = "down";
      pill.title = "unhealthy";
    } else {
      pill.classList.add("pill-unknown");
      pill.textContent = "?";
      pill.title = "not checked";
    }
  }

  var KNOWN_JOB_STATUSES = {
    queued: 1, running: 1, completed: 1, failed: 1, cancelled: 1, interrupted: 1
  };

  function statusPillClass(status) {
    return KNOWN_JOB_STATUSES[status] ? "pill-" + status : "pill-unknown";
  }

  function renderJobs() {
    while (jobsBody.firstChild) jobsBody.removeChild(jobsBody.firstChild);
    if (state.jobs.length === 0) {
      var emptyTr = document.createElement("tr");
      emptyTr.className = "jobs-empty";
      var emptyTd = document.createElement("td");
      emptyTd.colSpan = 8;
      emptyTd.className = "muted";
      emptyTd.textContent = "No jobs match this filter.";
      emptyTr.appendChild(emptyTd);
      jobsBody.appendChild(emptyTr);
    }
    for (var i = 0; i < state.jobs.length; i++) {
      var job = state.jobs[i];
      var tr = document.createElement("tr");
      if (job.id === state.selectedJobId) tr.classList.add("selected");
      tr.dataset.jobId = job.id;
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("aria-label", "Open job " + shortId(job.id));

      var idCell = document.createElement("td");
      idCell.className = "mono";
      idCell.title = job.id == null ? "" : String(job.id);
      idCell.textContent = shortId(job.id);

      var typeCell = document.createElement("td");
      typeCell.textContent = job.type == null ? "" : String(job.type);

      var statusCell = document.createElement("td");
      var statusPill = document.createElement("span");
      statusPill.className = "pill " + statusPillClass(job.status);
      statusPill.textContent = job.status == null || job.status === "" ? "?" : String(job.status);
      statusCell.appendChild(statusPill);

      var createdCell = document.createElement("td");
      createdCell.className = "mono";
      createdCell.textContent = fmtDate(job.created_at);

      var startedCell = document.createElement("td");
      startedCell.className = "mono";
      startedCell.textContent = fmtDate(job.started_at);

      var finishedCell = document.createElement("td");
      finishedCell.className = "mono";
      finishedCell.textContent = fmtDate(job.finished_at);

      var exitCell = document.createElement("td");
      exitCell.className = "mono";
      exitCell.textContent = (job.exit_code === null || job.exit_code === undefined)
        ? ""
        : String(job.exit_code);

      var actionCell = document.createElement("td");
      var openBtn = document.createElement("button");
      openBtn.dataset.action = "open-job";
      openBtn.dataset.id = job.id == null ? "" : String(job.id);
      openBtn.textContent = "open";
      actionCell.appendChild(openBtn);

      tr.appendChild(idCell);
      tr.appendChild(typeCell);
      tr.appendChild(statusCell);
      tr.appendChild(createdCell);
      tr.appendChild(startedCell);
      tr.appendChild(finishedCell);
      tr.appendChild(exitCell);
      tr.appendChild(actionCell);

      jobsBody.appendChild(tr);
    }
    var shown = state.jobs.length;
    var total = state.jobsTotal;
    jobsTotalEl.textContent = shown + " shown / " + total + " total";
  }

  function renderDetail() {
    var job = state.job;
    if (!job) {
      detailEmpty.classList.remove("hidden");
      detailBody.classList.add("hidden");
      return;
    }
    detailEmpty.classList.add("hidden");
    detailBody.classList.remove("hidden");
    el("d-id").textContent = job.id || "";
    el("d-type").textContent = job.type || "";
    var statusEl = el("d-status");
    statusEl.className = "pill " + statusPillClass(job.status);
    statusEl.textContent = job.status || "?";
    el("d-exit").textContent = (job.exit_code === null || job.exit_code === undefined) ? "" : String(job.exit_code);
    el("d-signal").textContent = job.signal || "";
    el("d-pid").textContent = job.pid || "";
    el("d-created").textContent = fmtDate(job.created_at);
    el("d-started").textContent = fmtDate(job.started_at);
    el("d-finished").textContent = fmtDate(job.finished_at);
    el("d-error").textContent = job.error || "";
    applyButtonStates();
  }

  function renderLogs() {
    var html = "";
    var items = state.logs.items;
    for (var i = 0; i < items.length; i++) {
      var l = items[i];
      var cls = "log-" + (l.stream || "stdout");
      html += "<span class='" + cls + "'>[" + (l.stream || "stdout") + "] " + escapeHtml(l.line) + "</span>\n";
    }
    logsEl.innerHTML = html || "<span class='muted'>(no logs)</span>";
    logsMeta.textContent =
      "showing " + state.logs.items.length + " / total " + state.logs.total +
      " (limit " + state.logs.limit + ", offset " + state.logs.offset + ", cap " + state.logs.maxLogLines + ")";
  }

  function renderArtifacts() {
    artifactsList.innerHTML = "";
    if (state.artifacts.length === 0) {
      var li = document.createElement("li");
      li.className = "a-empty";
      li.textContent = "(no artifacts)";
      artifactsList.appendChild(li);
    } else {
      for (var i = 0; i < state.artifacts.length; i++) {
        artifactsList.appendChild(renderArtifactItem(state.artifacts[i], false));
      }
    }
    artifactsMeta.textContent = state.artifacts.length + " item(s), source: " + (state.artifactsSource || "jobStore");
  }

  function renderPerJobArtifacts() {
    perjobList.innerHTML = "";
    if (state.perJobArtifacts.length === 0) {
      var li = document.createElement("li");
      li.className = "a-empty";
      li.textContent = "(no per-job artifacts yet)";
      perjobList.appendChild(li);
    } else {
      for (var i = 0; i < state.perJobArtifacts.length; i++) {
        perjobList.appendChild(renderArtifactItem(state.perJobArtifacts[i], true));
      }
    }
    perjobMeta.textContent = state.perJobArtifacts.length + " item(s)";
  }

  function renderArtifactItem(a, perJob) {
    var li = document.createElement("li");
    var name = document.createElement("span");
    name.className = "a-name";
    name.textContent = a.name;
    var meta = document.createElement("span");
    meta.className = "a-meta";
    meta.textContent = "id=" + a.id + " job=" + shortId(a.jobId) + " size=" + humanSize(a.size) + " mtime=" + fmtDate(a.mtime);
    var btn = document.createElement("button");
    btn.textContent = "Download";
    btn.dataset.action = "download";
    btn.dataset.id = String(a.id);
    btn.dataset.name = a.name;
    btn.dataset.perjob = perJob ? "1" : "0";
    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(btn);
    return li;
  }

  function humanSize(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MiB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GiB";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- event wiring ---
  function wireEvents() {
    tokenInput.value = state.token;
    tokenInput.addEventListener("input", function () {
      state.token = tokenInput.value.trim();
    });
    tokenInput.addEventListener("change", function () {
      state.token = tokenInput.value.trim();
      if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
      else localStorage.removeItem(TOKEN_KEY);
    });

    healthBtn.addEventListener("click", checkHealth);
    el("btn-health").dataset.action = "health";

    jobsStatus.addEventListener("change", function () {
      state.jobsFilter.status = jobsStatus.value;
      loadJobs();
    });
    jobsLimit.addEventListener("change", function () {
      var v = parseInt(jobsLimit.value, 10);
      state.jobsFilter.limit = isFinite(v) && v >= 1 ? Math.min(v, 200) : 20;
      jobsLimit.value = String(state.jobsFilter.limit);
      loadJobs();
    });
    jobsOffset.addEventListener("change", function () {
      var v = parseInt(jobsOffset.value, 10);
      state.jobsFilter.offset = isFinite(v) && v >= 0 ? v : 0;
      jobsOffset.value = String(state.jobsFilter.offset);
      loadJobs();
    });

    // Delegated click handler for job rows: the entire row opens the job
    // (data-job-id), but the open button inside the row keeps its own
    // data-action="open-job" path so we skip when a button is the target.
    jobsBody.addEventListener("click", function (ev) {
      var target = ev.target;
      if (!target) return;
      if (target.closest && target.closest("button[data-action]")) return;
      var tr = target.closest && target.closest("tr");
      if (!tr || !tr.dataset || !tr.dataset.jobId) return;
      if (tr.classList.contains("jobs-empty")) return;
      selectJob(tr.dataset.jobId);
    });

    // Keyboard support: Enter or Space on a focused row opens the job.
    jobsBody.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var target = ev.target;
      if (!target || !target.closest) return;
      var tr = target.closest("tr");
      if (!tr || !tr.dataset || !tr.dataset.jobId) return;
      if (tr.classList.contains("jobs-empty")) return;
      ev.preventDefault();
      selectJob(tr.dataset.jobId);
    });

    submitForm.addEventListener("submit", submitJob);

    // Delegated click handler for data-action buttons
    document.addEventListener("click", function (ev) {
      var target = ev.target;
      if (!target || !target.dataset || !target.dataset.action) return;
      if (target.tagName === "BUTTON" && target.disabled) return;
      var action = target.dataset.action;
      if (action === "health") return checkHealth();
      if (action === "refresh-jobs") return loadJobs();
      if (action === "refresh-detail") return loadDetail(state.selectedJobId);
      if (action === "refresh-logs") return loadLogs();
      if (action === "refresh-artifacts") return loadArtifacts();
      if (action === "refresh-perjob") return loadPerJobArtifacts();
      if (action === "cancel") return cancelJob();
      if (action === "open-job") {
        return selectJob(target.dataset.id);
      }
      if (action === "download") {
        var id = parseInt(target.dataset.id, 10);
        var isLegacy = id === -1;
        if (isLegacy) {
          showAlert("Legacy artifact has no JobStore id; not downloadable from UI.");
          return Promise.resolve();
        }
        var name = target.dataset.name;
        return downloadArtifact({ id: id, name: name });
      }
      return undefined;
    });
  }

  // --- init ---
  function init() {
    renderHealth();
    wireEvents();
    loadJobs().then(loadArtifacts);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
