(() => {
  "use strict";

  const POLL_INTERVAL_MS = 5_000;
  const THREAD_LIMIT = 50;
  const DEFAULT_FILE_PAGE_SIZE = 100;
  const TAB_ORDER = ["overview", "insights", "threads", "storage", "activity", "about"];
  const TAB_COPY = {
    overview: ["Overview", "A live view of Codex on this machine."],
    insights: ["Insights", "Public reset history and local model usage by thinking level."],
    threads: ["Threads", "Searchable local thread metadata."],
    storage: ["Storage", "A read-only view of the Codex disk footprint."],
    activity: ["Activity", "Operational events, tools, and usage counters."],
    about: ["About", "How Xedoc observes Codex while respecting content boundaries."],
  };

  const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const integerFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const compactFormatter = new Intl.NumberFormat(undefined, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  });
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const dayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const calendarWeekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
  const calendarWeekdayLongFormatter = new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" });
  const calendarMonthFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const calendarMonthOnlyFormatter = new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" });
  const calendarDateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  let apiToken = "";

  const state = {
    snapshot: null,
    activeTab: "overview",
    snapshotBusy: false,
    pollTimer: null,
    relativeTimer: null,
    threadDebounce: null,
    insights: {
      data: null,
      loading: false,
      loaded: false,
      controller: null,
    },
    resetHistory: {
      data: null,
      loading: false,
      loaded: false,
      controller: null,
    },
    threads: {
      items: [],
      total: null,
      offset: 0,
      query: "",
      loading: false,
      loaded: false,
      hasMore: false,
      controller: null,
    },
    files: {
      items: [],
      total: null,
      offset: 0,
      path: "",
      loading: false,
      loaded: false,
      hasMore: false,
      pageSize: DEFAULT_FILE_PAGE_SIZE,
      nextOffset: null,
      scanLimited: false,
      controller: null,
    },
    activityThreadId: "",
    activityDetails: new Map(),
    activityController: null,
    activityLoading: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }

  function toNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function firstNumber(...values) {
    for (const value of values) {
      const parsed = toNumber(value);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  function cleanText(value, fallback = "—") {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatInteger(value) {
    const numeric = toNumber(value);
    return numeric === null ? "—" : integerFormatter.format(numeric);
  }

  function formatCompact(value) {
    const numeric = toNumber(value);
    if (numeric === null) return "—";
    return Math.abs(numeric) >= 1_000 ? compactFormatter.format(numeric) : integerFormatter.format(numeric);
  }

  function formatBytes(value) {
    const bytes = toNumber(value);
    if (bytes === null || bytes < 0) return "—";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / 1024 ** exponent;
    const digits = amount >= 100 || exponent === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[exponent]}`;
  }

  function formatPercent(value) {
    const numeric = toNumber(value);
    return numeric === null ? "—" : `${numberFormatter.format(numeric)}%`;
  }

  function formatDuration(secondsValue) {
    const seconds = toNumber(secondsValue);
    if (seconds === null || seconds < 0) return "—";
    if (seconds === 0) return "0s";
    if (seconds < 1) return "<1s";
    const roundedSeconds = Math.round(seconds);
    if (roundedSeconds < 60) return `${roundedSeconds}s`;
    const minutes = Math.floor(roundedSeconds / 60);
    if (minutes < 60) return `${minutes}m ${roundedSeconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  function formatThinkingLevel(value) {
    const normalized = cleanText(value, "unknown").trim().toLowerCase();
    const labels = {
      none: "None",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "X-high",
      max: "Max",
      ultra: "Ultra",
      unknown: "Unknown",
    };
    return labels[normalized] || formatKey(value);
  }

  function parseDate(value) {
    if (value === undefined || value === null || value === "") return null;
    const dateOnly = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = value instanceof Date
      ? value
      : dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parseUtcDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
  }

  function calendarRangeLabel(calendar) {
    const start = parseUtcDateKey(calendar?.from);
    const end = parseUtcDateKey(calendar?.to);
    if (!start || !end) return "Past 30 days";
    if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
      return calendarMonthFormatter.format(start);
    }
    if (start.getUTCFullYear() === end.getUTCFullYear()) {
      return `${calendarMonthOnlyFormatter.format(start)} – ${calendarMonthFormatter.format(end)}`;
    }
    return `${calendarMonthFormatter.format(start)} – ${calendarMonthFormatter.format(end)}`;
  }

  function formatDate(value) {
    const date = parseDate(value);
    return date ? dateFormatter.format(date) : "—";
  }

  function formatRelative(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    if (absolute < 5) return "just now";
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (absolute < 60) return formatter.format(Math.round(seconds), "second");
    if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
    if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
    if (absolute < 604_800) return formatter.format(Math.round(seconds / 86_400), "day");
    return formatDate(date);
  }

  function formatKey(value) {
    return String(value)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/^./, (letter) => letter.toUpperCase());
  }

  function shortId(value) {
    const text = cleanText(value, "");
    if (!text) return "unknown";
    return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
  }

  function pathLeaf(value) {
    const text = cleanText(value, "").replaceAll("\\", "/").replace(/\/+$/, "");
    return text.split("/").filter(Boolean).at(-1) || text;
  }

  function setText(id, value) {
    const element = typeof id === "string" ? document.getElementById(id) : id;
    if (element) element.textContent = cleanText(value);
  }

  function toggleHidden(id, hidden) {
    const element = typeof id === "string" ? document.getElementById(id) : id;
    if (element) element.classList.toggle("is-hidden", Boolean(hidden));
  }

  function clearElement(element) {
    if (element) element.replaceChildren();
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function createSvgIcon(kind) {
    const definitions = {
      thread: [["path", { d: "M5 5.5h14v10H9l-4 3v-13Z" }]],
      process: [["rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "2" }], ["path", { d: "m7 9 2.5 2L7 13M12 13h4" }]],
      folder: [["path", { d: "M3.5 6.5h6l2 2h9v10h-17v-12Z" }]],
      file: [["path", { d: "M6 3.5h8l4 4v13H6v-17Z" }], ["path", { d: "M14 3.5v4h4" }]],
      chevron: [["path", { d: "m9 6 6 6-6 6" }]],
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of definitions[kind] || definitions.file) {
      const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, value);
      svg.append(child);
    }
    return svg;
  }

  function createCell(label, content, className = "") {
    const cell = createElement("td", className);
    cell.dataset.label = label;
    if (content instanceof Node) cell.append(content);
    else cell.textContent = cleanText(content);
    return cell;
  }

  function setRelativeElement(element, value) {
    const date = parseDate(value);
    if (!element) return;
    if (!date) {
      element.textContent = "—";
      element.removeAttribute("data-relative-time");
      element.removeAttribute("title");
      return;
    }
    element.dataset.relativeTime = date.toISOString();
    element.textContent = formatRelative(date);
    element.title = date.toLocaleString();
    if (element.tagName === "TIME") element.dateTime = date.toISOString();
  }

  function refreshRelativeTimes() {
    $$('[data-relative-time]').forEach((element) => {
      element.textContent = formatRelative(element.dataset.relativeTime);
    });
  }

  function announce(message) {
    const region = $("#app-live-region");
    if (!region) return;
    region.textContent = "";
    window.setTimeout(() => { region.textContent = message; }, 25);
  }

  function showToast(message, kind = "info") {
    const region = $("#toast-region");
    if (!region) return;
    const toast = createElement("div", "toast", message);
    toast.dataset.kind = kind;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 4_000);
  }

  function setInlineMessage(id, message, kind = "error") {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = cleanText(message, "");
    element.dataset.kind = kind;
    element.classList.toggle("is-hidden", !message);
  }

  function getApiToken() {
    return apiToken;
  }

  function bootstrapApiToken() {
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = parameters.get("token") || "";
    if (/^[a-zA-Z0-9_-]{32,256}$/.test(fragmentToken)) {
      apiToken = fragmentToken;
      try {
        window.sessionStorage.setItem("xedoc-token", fragmentToken);
      } catch (_error) {
        // In-memory authentication still works when browser storage is disabled.
      }
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#overview`);
      return;
    }
    try {
      apiToken = window.sessionStorage.getItem("xedoc-token") || "";
    } catch (_error) {
      apiToken = "";
    }
  }

  async function apiFetch(path, options = {}) {
    const token = getApiToken();
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (token) headers.set("X-Xedoc-Token", token);
    const response = await fetch(path, {
      ...options,
      headers,
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      let serverMessage = "";
      try {
        const body = await response.json();
        serverMessage = cleanText(firstDefined(body.error, body.message, body.reason), "");
      } catch (_error) {
        // A non-JSON error body is intentionally ignored.
      }
      const error = new Error(serverMessage || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function readableError(error) {
    if (error?.name === "AbortError") return "Request cancelled.";
    if (error?.status === 401 || error?.status === 403) return "Local access token rejected. Reopen the full Dashboard URL printed by Xedoc.";
    if (error instanceof TypeError) return "The local Xedoc service is unreachable.";
    return cleanText(error?.message, "The local request failed.");
  }

  function setConnection(mode, label) {
    const element = $("#connection-status");
    if (element) element.dataset.state = mode;
    element?.setAttribute("aria-label", `Connection: ${label}`);
    setText("connection-label", label);
  }

  function unwrapSnapshot(payload) {
    if (isObject(payload?.snapshot)) return payload.snapshot;
    return isObject(payload) ? payload : {};
  }

  async function loadSnapshot({ manual = false } = {}) {
    if (state.snapshotBusy) return false;
    state.snapshotBusy = true;
    window.clearTimeout(state.pollTimer);
    const refreshButton = $("#refresh-button");
    refreshButton?.classList.add("is-loading");
    refreshButton?.setAttribute("aria-busy", "true");
    if (!state.snapshot) setConnection("loading", "Connecting");
    try {
      const payload = await apiFetch(manual ? "/api/snapshot?storage=refresh" : "/api/snapshot");
      state.snapshot = unwrapSnapshot(payload);
      renderSnapshot();
      setConnection("live", "Live");
      if (state.activeTab === "activity" && state.activityThreadId) {
        void loadActivity(state.activityThreadId, { silent: true });
      }
      if (manual) announce("Dashboard refreshed.");
      return true;
    } catch (error) {
      if (error?.name !== "AbortError") {
        setConnection("error", state.snapshot ? "Stale" : "Unavailable");
        if (manual || !state.snapshot) showToast(readableError(error), "error");
      }
      return false;
    } finally {
      state.snapshotBusy = false;
      refreshButton?.classList.remove("is-loading");
      refreshButton?.removeAttribute("aria-busy");
      schedulePolling();
    }
  }

  function schedulePolling() {
    window.clearTimeout(state.pollTimer);
    if (document.hidden) return;
    state.pollTimer = window.setTimeout(() => loadSnapshot(), POLL_INTERVAL_MS);
  }

  function renderSnapshot() {
    if (!state.snapshot) return;
    renderLastUpdated();
    renderSummary();
    renderRuntime();
    renderInstallation();
    renderUsage();
    renderHealth();
    renderStorage();
    renderActivityThreadOptions();
    renderActivity();
    renderAbout();
  }

  function renderLastUpdated() {
    const generatedAt = firstDefined(state.snapshot.generatedAt, state.snapshot.updatedAt, new Date().toISOString());
    setRelativeElement($("#last-updated"), generatedAt);
  }

  function renderSummary() {
    const stats = isObject(state.snapshot.stats) ? state.snapshot.stats : {};
    setText("stat-threads", formatInteger(firstDefined(stats.threads, stats.totalThreads)));
    setText("stat-active-threads", formatInteger(firstDefined(stats.activeThreads, stats.runningThreads)));
    setText("stat-tokens", formatCompact(firstDefined(stats.totalTokens, stats.tokens)));
    setText("stat-storage", formatBytes(firstDefined(stats.storageBytes, state.snapshot.storage?.totalBytes)));
    setText("stat-warnings", formatInteger(firstDefined(stats.warnings24h, stats.warnings)));
    setText("stat-errors", formatInteger(firstDefined(stats.errors24h, stats.errors)));
  }

  function processName(process) {
    return cleanText(firstDefined(process?.name, process?.processName, process?.executableName, process?.kind), "Codex process");
  }

  function renderRuntime() {
    const runtime = isObject(state.snapshot.runtime) ? state.snapshot.runtime : {};
    const processes = asArray(runtime.processes);
    const supported = runtime.supported !== false && !runtime.error;
    const status = $("#runtime-status");
    if (status) {
      status.dataset.state = supported ? "live" : "unavailable";
      status.lastChild.textContent = supported ? "Observed" : "Unavailable";
    }

    const rssBytes = supported ? firstNumber(runtime.totalRssBytes, runtime.rssBytes, runtime.memoryBytes) : null;
    const memoryPercent = supported ? firstNumber(runtime.memoryPercent, runtime.totalMemoryPercent) : null;
    setText("runtime-memory", formatBytes(rssBytes));
    const meter = $("#memory-meter");
    if (meter) {
      meter.dataset.level = String(memoryPercent === null ? 0 : Math.round(clamp(memoryPercent, 0, 100) / 10));
      meter.setAttribute("aria-label", memoryPercent === null
        ? `Codex processes use ${formatBytes(rssBytes)} of memory`
        : `Codex processes use ${formatPercent(memoryPercent)} memory, ${formatBytes(rssBytes)}`);
    }
    setText("runtime-cpu", supported ? formatPercent(firstDefined(runtime.totalCpuPercent, runtime.cpuPercent)) : "—");
    setText("runtime-processes", supported ? formatInteger(firstDefined(runtime.processCount, processes.length)) : "—");
    setText("runtime-worker-memory", supported ? formatBytes(firstDefined(runtime.workerRssBytes, runtime.coreRssBytes)) : "—");
    setText("runtime-uptime", supported ? formatDuration(firstDefined(runtime.longestUptimeSec, runtime.uptimeSec)) : "—");

    const message = cleanText(firstDefined(runtime.error, runtime.note, !supported ? "Runtime process metrics are not supported on this platform." : ""), "");
    setInlineMessage("runtime-message", message, supported ? "info" : "error");

    const tableBody = $("#runtime-process-list");
    clearElement(tableBody);
    processes.slice(0, 8).forEach((process) => {
      const row = document.createElement("tr");
      const primary = createElement("div", "table-primary");
      const icon = createElement("span", "table-icon");
      icon.append(createSvgIcon("process"));
      const copy = createElement("span", "table-primary-text");
      copy.append(createElement("strong", "", processName(process)));
      const processKind = firstDefined(process?.kind, process?.role);
      if (processKind) copy.append(createElement("small", "", processKind));
      primary.append(icon, copy);
      row.append(
        createCell("Process", primary),
        createCell("PID", formatInteger(firstDefined(process?.pid, process?.processId)), "mono"),
        createCell("Memory", formatBytes(firstDefined(process?.rssBytes, process?.memoryBytes))),
        createCell("CPU", formatPercent(firstDefined(process?.cpuPercent, process?.cpu))),
      );
      tableBody?.append(row);
    });
    toggleHidden("runtime-table-wrap", processes.length === 0);
  }

  function renderInstallation() {
    const codex = isObject(state.snapshot.codex) ? state.snapshot.codex : {};
    const stats = isObject(state.snapshot.stats) ? state.snapshot.stats : {};
    const storage = isObject(state.snapshot.storage) ? state.snapshot.storage : {};
    const logs = isObject(state.snapshot.logs) ? state.snapshot.logs : {};
    const goals = isObject(state.snapshot.goals) ? state.snapshot.goals : null;
    const rawVersion = cleanText(codex.version, "");
    const cliVersion = rawVersion.match(/^codex-cli\s+(.+)$/i);
    const versionLabel = cliVersion
      ? `CLI ${cliVersion[1]}`
      : rawVersion && rawVersion !== "unavailable" ? rawVersion : "CLI unavailable";
    setText("codex-version", versionLabel);
    const versionElement = $("#codex-version");
    if (versionElement) versionElement.title = rawVersion ? `Installed command: ${rawVersion}` : "Installed Codex CLI version unavailable";
    setText("codex-home", cleanText(codex.home));
    const home = $("#codex-home");
    if (home) home.title = cleanText(codex.home, "");
    setText("codex-platform", cleanText(firstDefined(codex.platform, codex.os)));
    setText("codex-archived", formatInteger(firstDefined(stats.archivedThreads, stats.archived)));
    setRelativeElement($("#storage-updated"), firstDefined(storage.updatedAt, storage.scannedAt));
    const topLogTarget = asArray(logs.targets)[0];
    setText("codex-log-target", logs.available === false
      ? "Unavailable"
      : topLogTarget ? `${cleanText(topLogTarget.target)} · ${formatInteger(topLogTarget.count)}` : "None in 24h");
    const logTarget = $("#codex-log-target");
    if (logTarget) logTarget.title = logTarget.textContent;
    setText("codex-goals", goals
      ? `${formatInteger(goals.activeGoals)} active · ${formatCompact(goals.tokensUsed)} tokens · ${formatDuration(goals.timeUsedSeconds)}`
      : "Not enabled");
  }

  function tokenTotal(value) {
    if (!isObject(value)) return firstNumber(value);
    const direct = firstNumber(value.totalTokens, value.total, value.tokens);
    if (direct !== null) return direct;
    const input = firstNumber(value.inputTokens, value.input, value.promptTokens);
    const output = firstNumber(value.outputTokens, value.output, value.completionTokens);
    return input === null && output === null ? null : (input || 0) + (output || 0);
  }

  function renderUsage() {
    const usage = isObject(state.snapshot.usage) ? state.snapshot.usage : {};
    const models = asArray(firstDefined(usage.byModel, usage.models));
    const modelReasoning = asArray(usage.byModelReasoning);
    const modelList = $("#model-usage-list");
    clearElement(modelList);
    const modelValues = models.map((item) => tokenTotal(item)).filter((value) => value !== null);
    const maxModelValue = Math.max(...modelValues, 1);
    models.slice(0, 8).forEach((item, index) => {
      const total = tokenTotal(item);
      const input = firstNumber(item?.inputTokens, item?.input, item?.promptTokens);
      const output = firstNumber(item?.outputTokens, item?.output, item?.completionTokens);
      const usageItem = createElement("div", "model-usage-item");
      const row = createElement("div", "bar-row");
      const label = createElement("div", "bar-label");
      label.append(
        createElement("strong", "", cleanText(firstDefined(item?.model, item?.name, item?.key, item?.id), `Model ${index + 1}`)),
        createElement("small", "", input === null && output === null ? "Token total" : `In ${formatCompact(input)} · Out ${formatCompact(output)}`),
      );
      const progress = createElement("progress", "bar-progress");
      progress.max = maxModelValue;
      progress.value = total || 0;
      progress.setAttribute("aria-label", `${cleanText(firstDefined(item?.model, item?.name, item?.key, item?.id), `Model ${index + 1}`)}: ${formatInteger(total)} tokens`);
      row.append(label, progress, createElement("span", "bar-value", formatCompact(total)));
      usageItem.append(row);

      const modelKey = cleanText(firstDefined(item?.model, item?.name, item?.key, item?.id), "");
      const efforts = modelReasoning.filter((entry) => cleanText(entry?.key, "") === modelKey);
      if (efforts.length) {
        const breakdown = createElement("div", "reasoning-breakdown");
        breakdown.setAttribute("aria-label", `${modelKey} tokens by thinking level`);
        efforts.forEach((entry) => {
          const effort = cleanText(entry?.reasoningEffort, "unknown");
          const chip = createElement("span", "reasoning-chip");
          chip.append(
            createElement("strong", "", effort === "unknown" ? "Level unknown" : effort),
            document.createTextNode(` ${formatCompact(tokenTotal(entry))}`),
          );
          chip.title = `${modelKey} · ${effort}: ${formatInteger(tokenTotal(entry))} tokens across ${formatInteger(entry?.threads)} tasks`;
          breakdown.append(chip);
        });
        usageItem.append(breakdown);
      }
      modelList?.append(usageItem);
    });
    toggleHidden("model-usage-empty", models.length > 0);

    const daily = asArray(firstDefined(usage.recentDaily, usage.daily));
    const chart = $("#daily-chart");
    clearElement(chart);
    const values = daily.map((item) => tokenTotal(item)).filter((value) => value !== null);
    const maxDaily = Math.max(...values, 1);
    const visibleDaily = daily.slice(-14);
    visibleDaily.forEach((item) => {
      const total = tokenTotal(item);
      const dateValue = firstDefined(item?.date, item?.day, item?.timestamp);
      const date = parseDate(dateValue);
      const column = createElement("div", "day-column");
      const wrap = createElement("div", "day-bar-wrap");
      const level = total === null || total <= 0 ? 0 : Math.max(1, Math.round((total / maxDaily) * 20));
      const bar = createElement("div", `day-bar day-bar--${level}`);
      bar.title = `${date ? date.toLocaleDateString() : cleanText(dateValue, "Unknown day")}: ${formatInteger(total)} tokens`;
      wrap.append(bar);
      column.append(wrap, createElement("span", "day-label", date ? dayFormatter.format(date) : cleanText(dateValue, "—")));
      chart?.append(column);
    });
    chart?.setAttribute("aria-label", visibleDaily.length
      ? `Thread tokens by creation date: ${visibleDaily.map((item) => `${cleanText(item?.date, "unknown date")} ${formatInteger(tokenTotal(item))} tokens`).join("; ")}`
      : "No daily token history is available");
    toggleHidden("daily-chart", daily.length === 0);
    toggleHidden("daily-empty", daily.length > 0);
    if (daily.length > 1) {
      const start = parseDate(firstDefined(daily[0]?.date, daily[0]?.day, daily[0]?.timestamp));
      const endItem = daily[daily.length - 1];
      const end = parseDate(firstDefined(endItem?.date, endItem?.day, endItem?.timestamp));
      setText("daily-range", start && end ? `${start.toLocaleDateString()} – ${end.toLocaleDateString()}` : "Recent days");
    } else {
      setText("daily-range", "Recent days");
    }
  }

  function renderResetCalendar(container, calendar) {
    clearElement(container);
    const days = calendar?.available === true ? asArray(calendar.days).slice(0, 49) : [];
    if (!container || days.length === 0 || days.length % 7 !== 0) return false;

    const range = calendarRangeLabel(calendar);
    const resetDays = days.filter((day) => toNumber(day?.count) > 0);
    container.setAttribute("aria-label", `${range} Codex reset announcement calendar in UTC; ${resetDays.length} announcement days`);

    const monday = Date.UTC(2026, 0, 5);
    const headerRow = createElement("div", "reset-calendar-row");
    headerRow.setAttribute("role", "row");
    for (let index = 0; index < 7; index += 1) {
      const weekdayDate = new Date(monday + index * 86_400_000);
      const weekday = createElement("div", "reset-calendar-weekday", calendarWeekdayFormatter.format(weekdayDate));
      weekday.setAttribute("role", "columnheader");
      weekday.setAttribute("aria-label", calendarWeekdayLongFormatter.format(weekdayDate));
      headerRow.append(weekday);
    }
    container.append(headerRow);

    const todayKey = new Date().toISOString().slice(0, 10);
    let calendarRow = null;
    days.forEach((day, index) => {
      if (index % 7 === 0) {
        calendarRow = createElement("div", "reset-calendar-row");
        calendarRow.setAttribute("role", "row");
        container.append(calendarRow);
      }
      const date = parseUtcDateKey(day?.date);
      if (!date) return;
      const count = Math.max(0, Math.round(toNumber(day?.count) || 0));
      const cell = createElement("div", "reset-calendar-day");
      cell.setAttribute("role", "gridcell");
      cell.classList.toggle("is-outside", day?.inWindow !== true);
      cell.classList.toggle("has-reset", count > 0);
      cell.classList.toggle("is-today", day.date === todayKey);
      const dateLabel = calendarDateFormatter.format(date);
      const status = day?.inWindow !== true
        ? "outside the selected window"
        : count > 0 ? `${count} reset announcement${count === 1 ? "" : "s"}` : "no reset announcements";
      cell.setAttribute("aria-label", `${dateLabel}: ${status}`);
      cell.title = `${dateLabel} · ${status}`;
      const dayNumber = createElement("time", "reset-calendar-number", String(date.getUTCDate()));
      dayNumber.dateTime = day.date;
      cell.append(dayNumber);
      if (count > 0) cell.append(createElement("span", "reset-calendar-count", String(count)));
      calendarRow?.append(cell);
    });
    return true;
  }

  function renderResetHistory(resetsValue) {
    const resets = isObject(resetsValue) ? resetsValue : {};
    const available = resets.available === true;
    const items = available ? asArray(resets.items) : [];
    const calendar = isObject(resets.calendar) ? resets.calendar : {};
    const overviewCalendarAvailable = renderResetCalendar($("#overview-reset-calendar"), calendar);
    const insightsCalendarAvailable = renderResetCalendar($("#insights-reset-calendar"), calendar);
    const calendarAvailable = overviewCalendarAvailable && insightsCalendarAvailable;
    const range = calendarRangeLabel(calendar);

    setRelativeElement($("#resets-fetched-at"), resets.fetchedAt);
    setText("reset-count", available ? formatInteger(firstDefined(resets.count, items.length)) : "—");
    setText("overview-reset-count", available ? formatInteger(firstDefined(resets.count, items.length)) : "—");
    setRelativeElement($("#reset-latest"), available ? resets.latestAt : null);
    setRelativeElement($("#overview-reset-latest"), available ? resets.latestAt : null);
    setText("overview-reset-range", range);
    setText("insights-reset-range", `${range} · UTC`);
    const averageDays = available ? toNumber(resets.averageIntervalDays) : null;
    setText("reset-average", averageDays === null ? "—" : `${numberFormatter.format(averageDays)} days`);
    toggleHidden("overview-reset-calendar-shell", !calendarAvailable);
    toggleHidden("insights-reset-calendar-shell", !calendarAvailable);
    toggleHidden("insights-reset-calendar-empty", calendarAvailable);
    setText($("#insights-reset-calendar-empty p"), cleanText(calendar.reason, "Reset calendar dates are unavailable."));
    setInlineMessage("overview-reset-message", available
      ? ""
      : cleanText(resets.reason, "Codex reset history is unavailable."), available ? "info" : "warning");

    const resetList = $("#reset-history-list");
    clearElement(resetList);
    items.forEach((reset) => {
      const row = document.createElement("tr");
      const announced = createElement("time", "reset-time", formatDate(reset?.announcedAt));
      const parsed = parseDate(reset?.announcedAt);
      if (parsed) announced.dateTime = parsed.toISOString();
      const sourceUrl = cleanText(reset?.sourceUrl, "");
      let source = "—";
      if (/^https:\/\/(?:x\.com|twitter\.com)\//.test(sourceUrl)) {
        source = createElement("a", "row-link", "View post ↗");
        source.href = sourceUrl;
        source.target = "_blank";
        source.rel = "noreferrer noopener";
      }
      row.append(
        createCell("Announced", announced),
        createCell("Announcement", cleanText(reset?.text, "Reset announcement"), "reset-copy"),
        createCell("Source", source),
      );
      resetList?.append(row);
    });
    toggleHidden("reset-history-table-wrap", items.length === 0);
    toggleHidden("reset-history-empty", items.length > 0);
    setText($("#reset-history-empty p"), available
      ? "No reset announcements were returned for the past 30 days."
      : cleanText(resets.reason, "Codex reset history is unavailable."));
  }

  async function loadResetHistory() {
    if (state.resetHistory.loading) return;
    state.resetHistory.controller?.abort();
    const controller = new AbortController();
    state.resetHistory.controller = controller;
    state.resetHistory.loading = true;
    setInlineMessage("overview-reset-message", state.resetHistory.loaded ? "Refreshing reset calendar…" : "Loading reset calendar…", "info");
    try {
      const payload = await apiFetch("/api/resets", { signal: controller.signal });
      state.resetHistory.data = isObject(payload?.resets) ? payload.resets : {};
      state.resetHistory.loaded = true;
      renderResetHistory(state.resetHistory.data);
    } catch (error) {
      if (error?.name !== "AbortError") setInlineMessage("overview-reset-message", readableError(error), "warning");
    } finally {
      if (state.resetHistory.controller === controller) state.resetHistory.controller = null;
      state.resetHistory.loading = false;
    }
  }

  async function loadInsights() {
    if (state.insights.loading) return;
    state.insights.controller?.abort();
    const controller = new AbortController();
    state.insights.controller = controller;
    state.insights.loading = true;
    setInlineMessage("insights-message", state.insights.loaded ? "Refreshing insights…" : "Loading insights…", "info");
    try {
      state.insights.data = await apiFetch("/api/insights", { signal: controller.signal });
      state.insights.loaded = true;
      if (isObject(state.insights.data?.resets)) {
        state.resetHistory.data = state.insights.data.resets;
        state.resetHistory.loaded = true;
      }
      setInlineMessage("insights-message", "");
      renderInsights();
    } catch (error) {
      if (error?.name !== "AbortError") setInlineMessage("insights-message", readableError(error));
    } finally {
      if (state.insights.controller === controller) state.insights.controller = null;
      state.insights.loading = false;
    }
  }

  function renderInsights() {
    const insights = isObject(state.insights.data) ? state.insights.data : {};
    const resets = isObject(insights.resets) ? insights.resets : state.resetHistory.data;
    const profilesData = isObject(insights.modelProfiles) ? insights.modelProfiles : {};
    const profilesAvailable = profilesData.available === true;
    const profiles = profilesAvailable ? asArray(profilesData.models) : [];

    const updatedTimes = [resets?.fetchedAt, profilesData.observedAt]
      .map((value) => parseDate(value)?.getTime())
      .filter((value) => Number.isFinite(value));
    setRelativeElement($("#insights-updated"), updatedTimes.length ? Math.max(...updatedTimes) : null);
    setRelativeElement($("#model-profiles-observed-at"), profilesData.observedAt);
    renderResetHistory(resets);

    const performanceList = $("#model-performance-list");
    clearElement(performanceList);
    profiles.forEach((profile) => {
      const row = document.createElement("tr");
      const modelName = createElement("div", "model-name-cell");
      modelName.append(createElement("strong", "", cleanText(profile?.model, "Unknown model")));
      row.append(
        createCell("Model", modelName),
        createCell("Thinking level", formatThinkingLevel(profile?.reasoningEffort), "reasoning-level-cell"),
        createCell("Tasks", formatInteger(profile?.tasks)),
        createCell("Total tokens", formatCompact(profile?.tokens)),
        createCell("Avg tokens/task", formatCompact(profile?.averageTokens)),
        createCell("Avg thread span", formatDuration(profile?.averageSpanSeconds)),
      );
      performanceList?.append(row);
    });
    toggleHidden("model-performance-table-wrap", profiles.length === 0);
    toggleHidden("model-performance-empty", profiles.length > 0);
    setText($("#model-performance-empty p"), profilesAvailable
      ? "No local tasks contain model and thinking-level metadata yet."
      : cleanText(profilesData.reason, "Local model profiles are unavailable."));
    setText("model-performance-note", `These are your local task totals, not standardized benchmark scores. Average span is updated-to-created wall time and can include idle time.${profilesData.limited ? " The table shows the 30 largest model/level groups." : ""}`);
  }

  function renderHealth() {
    const health = isObject(state.snapshot.health) ? state.snapshot.health : {};
    const warnings = asArray(firstDefined(health.warnings, state.snapshot.warnings));
    const list = $("#health-list");
    clearElement(list);
    warnings.slice(0, 8).forEach((warning) => {
      const item = isObject(warning) ? warning : { message: warning };
      const level = cleanText(firstDefined(item.level, item.severity), "warning").toLowerCase();
      const row = createElement("li", "signal-item");
      row.dataset.level = level;
      const marker = createElement("span", "signal-marker", level === "error" ? "×" : "!");
      marker.setAttribute("aria-hidden", "true");
      const copy = createElement("div");
      copy.append(
        createElement("strong", "", cleanText(firstDefined(item.title, item.code, item.type), level === "error" ? "Error" : "Warning")),
        createElement("p", "", cleanText(firstDefined(item.message, item.summary, item.detail), "Operational warning reported.")),
      );
      row.append(marker, copy);
      list?.append(row);
    });
    setText("health-count", formatInteger(warnings.length));
    toggleHidden("health-list", warnings.length === 0);
    toggleHidden("health-empty", warnings.length > 0);
  }

  function storageFileName(item) {
    const direct = firstDefined(item?.name, item?.fileName);
    if (direct) return String(direct);
    const path = cleanText(firstDefined(item?.path, item?.relativePath), "");
    const pieces = path.replace(/\\/g, "/").split("/").filter(Boolean);
    return pieces.at(-1) || "Unnamed file";
  }

  function renderStorage() {
    const storage = isObject(state.snapshot.storage) ? state.snapshot.storage : {};
    const stats = isObject(state.snapshot.stats) ? state.snapshot.stats : {};
    const groups = asArray(storage.groups);
    const tempFiles = asArray(storage.tempFiles);
    const openFiles = asArray(storage.openFiles);
    const openFilesAvailable = storage.openFilesAvailable !== false;
    const rollouts = asArray(storage.largestRollouts);
    const totalBytes = firstNumber(storage.totalBytes, stats.storageBytes);
    const storageAvailable = storage.available !== false;
    const tempBytes = storageAvailable
      ? firstNumber(storage.tempBytes) ?? tempFiles.reduce((sum, file) => sum + (firstNumber(file?.sizeBytes, file?.bytes, file?.size) || 0), 0)
      : null;
    setRelativeElement($("#storage-scan-time"), firstDefined(storage.updatedAt, storage.scannedAt));
    setInlineMessage("storage-message", storage.available === false
      ? cleanText(storage.error, "Storage metadata is unavailable.") : "", storage.available === false ? "error" : "info");
    setText("storage-total", formatBytes(totalBytes));
    setText("storage-temp-count", storageAvailable
      ? `${formatInteger(firstDefined(storage.tempFileCount, tempFiles.length))}${storage.tempScanLimited ? "+" : ""}` : "—");
    setText("storage-temp-size", storageAvailable
      ? storage.tempScanLimited || storage.tempMeasurementLimited
        ? `At least ${formatBytes(tempBytes)} measured`
        : `${formatBytes(tempBytes)} on disk`
      : "Unavailable");
    setText("storage-open-count", openFilesAvailable
      ? `${formatInteger(openFiles.length)}${storage.openFilesLimited ? "+" : ""}` : "—");
    setText("open-files-label", storage.openFilesLimited
      ? `First ${formatInteger(Math.min(20, openFiles.length))} of ${formatInteger(openFiles.length)}+`
      : "Metadata only");

    const groupList = $("#storage-group-list");
    clearElement(groupList);
    const groupMax = Math.max(...groups.map((group) => firstNumber(group?.bytes, group?.sizeBytes, group?.size) || 0), 1);
    groups.forEach((group, index) => {
      const bytes = firstNumber(group?.bytes, group?.sizeBytes, group?.size);
      const row = createElement("div", "storage-group");
      const label = cleanText(firstDefined(group?.label, group?.name, group?.kind), `Group ${index + 1}`);
      row.append(createElement("span", "storage-group-label", label));
      const progress = createElement("progress", "storage-group-progress");
      progress.max = groupMax;
      progress.value = bytes || 0;
      progress.setAttribute("aria-label", `${label}: ${formatBytes(bytes)}`);
      row.append(progress, createElement("span", "storage-group-value", formatBytes(bytes)));
      groupList?.append(row);
    });
    toggleHidden("storage-groups-empty", groups.length > 0);

    const tempList = $("#temp-file-list");
    clearElement(tempList);
    tempFiles.slice(0, 12).forEach((file) => {
      const row = document.createElement("tr");
      const name = createElement("div", "table-primary-text");
      name.append(createElement("strong", "", storageFileName(file)));
      const relativePath = firstDefined(file?.relativePath, file?.path);
      if (relativePath) name.append(createElement("small", "mono", relativePath));
      row.append(
        createCell("File", name),
        createCell("Size", formatBytes(firstDefined(file?.sizeBytes, file?.bytes, file?.size))),
        createCell("Modified", formatRelative(firstDefined(file?.modifiedAt, file?.mtime, file?.updatedAt))),
      );
      tempList?.append(row);
    });
    toggleHidden("temp-files-empty", tempFiles.length > 0);

    const openList = $("#open-file-list");
    clearElement(openList);
    openFiles.slice(0, 20).forEach((file) => {
      const row = document.createElement("tr");
      const path = createElement("span", "mono truncate", cleanText(firstDefined(file?.path, file?.relativePath, file?.name)));
      path.title = path.textContent;
      row.append(
        createCell("Path", path),
        createCell("Process", cleanText(firstDefined(file?.processName, file?.process, file?.pid))),
        createCell("Descriptor", cleanText(firstDefined(file?.fd, file?.descriptor, file?.handle))),
      );
      openList?.append(row);
    });
    toggleHidden("open-files-empty", openFiles.length > 0);
    setText($("#open-files-empty p"), openFilesAvailable
      ? "No open file handles were reported."
      : cleanText(storage.openFilesError, "Open-file metadata is unavailable."));

    const rolloutList = $("#rollout-file-list");
    clearElement(rolloutList);
    rollouts.slice(0, 24).forEach((file) => {
      const row = document.createElement("tr");
      const id = cleanText(firstDefined(file?.threadId, file?.id), "");
      const cwd = cleanText(firstDefined(file?.cwd, file?.projectPath), "");
      const indexedName = cleanText(firstDefined(file?.taskName, file?.threadName), "");
      const unlinkedSubagent = Boolean(file?.unlinkedSubagent);
      const agentNickname = cleanText(file?.agentNickname, "");
      const taskName = unlinkedSubagent
        ? agentNickname ? `Subagent ${agentNickname}` : "Unlinked subagent history"
        : indexedName || (cwd ? `Untitled task in ${pathLeaf(cwd)}` : id ? `Untitled task ${shortId(id)}` : "Untitled task");
      const primary = createElement("div", "table-primary rollout-task-primary");
      const icon = createElement("span", "table-icon");
      icon.append(createSvgIcon("thread"));
      const copy = createElement("span", "table-primary-text rollout-task-copy");
      const title = createElement("strong", "", taskName);
      title.title = taskName;
      const statusAndProject = [
        unlinkedSubagent ? "Parent task unavailable" : file?.archived ? "Archived" : "Current",
        cwd || null,
      ].filter(Boolean).join(" · ");
      const context = createElement("small", "rollout-project-line", statusAndProject);
      context.title = cwd;
      const idKind = unlinkedSubagent ? "Subagent ID" : "Task ID";
      const taskId = createElement("small", "mono rollout-task-id", id ? `${idKind} ${id}` : `${idKind} unavailable`);
      taskId.title = id;
      const largestPathValue = cleanText(firstDefined(file?.largestRolloutPath, file?.path, file?.relativePath), "");
      const largestPath = createElement("small", "mono rollout-path-line", largestPathValue ? `Largest file ${largestPathValue}` : "Largest file unavailable");
      largestPath.title = largestPathValue;
      copy.append(title, context, taskId, largestPath);
      primary.append(icon, copy);
      row.append(
        createCell("Task", primary),
        createCell("Rollouts", formatInteger(firstDefined(file?.rolloutCount, 1))),
        createCell("Total size", formatBytes(firstDefined(file?.bytes, file?.sizeBytes, file?.size))),
        createCell("Updated", formatRelative(firstDefined(file?.modifiedAt, file?.mtime, file?.updatedAt))),
      );
      rolloutList?.append(row);
    });
    toggleHidden("rollout-files-empty", rollouts.length > 0);
    setInlineMessage("rollout-scan-note", storage.rolloutScanLimited
      ? "Task totals are lower bounds grouped from the 5,000 most recently indexed rollout paths."
      : "", "info");
  }

  function collectionFromPayload(payload, keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return [];
  }

  function payloadTotal(payload) {
    return firstNumber(payload?.total, payload?.pagination?.total, payload?.meta?.total, payload?.count);
  }

  async function loadThreads({ offset = state.threads.offset, query = state.threads.query } = {}) {
    state.threads.controller?.abort();
    const controller = new AbortController();
    state.threads.controller = controller;
    state.threads.loading = true;
    toggleHidden("thread-search-spinner", false);
    setInlineMessage("threads-message", "");
    $("#thread-prev")?.setAttribute("disabled", "");
    $("#thread-next")?.setAttribute("disabled", "");
    const parameters = new URLSearchParams({
      limit: String(THREAD_LIMIT),
      offset: String(Math.max(0, offset)),
      q: query,
    });
    try {
      const payload = await apiFetch(`/api/threads?${parameters}`, { signal: controller.signal });
      if (state.threads.controller !== controller) return;
      if (payload?.error) throw new Error(cleanText(payload.error));
      const items = collectionFromPayload(payload, ["threads", "items", "results", "data"]);
      const total = payloadTotal(payload);
      const responseOffset = firstNumber(payload?.offset, payload?.pagination?.offset, offset) || 0;
      const explicitHasMore = firstDefined(payload?.hasMore, payload?.pagination?.hasMore);
      state.threads.items = items;
      state.threads.total = total;
      state.threads.offset = responseOffset;
      state.threads.query = query;
      state.threads.hasMore = typeof explicitHasMore === "boolean"
        ? explicitHasMore
        : total !== null ? responseOffset + items.length < total : items.length === THREAD_LIMIT;
      state.threads.loaded = true;
      renderThreads();
      renderActivityThreadOptions();
    } catch (error) {
      if (error?.name !== "AbortError") {
        setInlineMessage("threads-message", readableError(error));
        if (!state.threads.loaded) {
          state.threads.items = [];
          renderThreads();
        }
      }
    } finally {
      if (state.threads.controller === controller) {
        state.threads.loading = false;
        toggleHidden("thread-search-spinner", true);
        updateThreadPagination();
      }
    }
  }

  function threadId(thread) {
    return cleanText(firstDefined(thread?.id, thread?.threadId, thread?.uuid), "");
  }

  function threadTitle(thread) {
    const id = threadId(thread);
    return cleanText(firstDefined(thread?.title, thread?.name, thread?.label, thread?.agentNickname), id ? `Thread ${shortId(id)}` : "Untitled thread");
  }

  function threadStatus(thread) {
    if (thread?.archived === true || thread?.isArchived === true) return "archived";
    if (thread?.active === true || thread?.isActive === true) return "active";
    const updatedAt = parseDate(firstDefined(thread?.updatedAt, thread?.lastActivityAt));
    if (updatedAt && Date.now() - updatedAt.getTime() <= 15 * 60 * 1_000) return "active";
    return cleanText(firstDefined(thread?.status, thread?.state), "idle").toLowerCase();
  }

  function threadTokens(thread) {
    return tokenTotal(firstDefined(thread?.tokenUsage, thread?.usage, thread?.tokens));
  }

  function threadDuration(thread) {
    const directSeconds = firstNumber(thread?.durationSec, thread?.elapsedSec, thread?.runtimeSec);
    if (directSeconds !== null) return directSeconds;
    const milliseconds = firstNumber(thread?.durationMs, thread?.elapsedMs, thread?.spanMs);
    if (milliseconds !== null) return milliseconds / 1_000;
    const start = parseDate(firstDefined(thread?.startedAt, thread?.createdAt));
    const end = parseDate(firstDefined(thread?.completedAt, thread?.endedAt, thread?.updatedAt));
    return start && end ? Math.max(0, (end.getTime() - start.getTime()) / 1_000) : null;
  }

  function renderThreads() {
    const list = $("#thread-list");
    clearElement(list);
    state.threads.items.forEach((thread) => {
      const id = threadId(thread);
      const row = document.createElement("tr");
      const primary = createElement("div", "table-primary");
      const icon = createElement("span", "table-icon");
      icon.append(createSvgIcon("thread"));
      const copy = createElement("span", "table-primary-text");
      copy.append(createElement("strong", "", threadTitle(thread)));
      const source = firstDefined(thread?.source, thread?.threadSource);
      const effort = firstDefined(thread?.reasoningEffort, thread?.reasoning);
      const secondary = [
        id ? shortId(id) : "No identifier",
        firstDefined(thread?.model, thread?.modelName),
        source ? `via ${source}` : null,
        effort ? `${effort} reasoning` : null,
      ].filter(Boolean).join(" · ");
      copy.append(createElement("small", "mono", secondary));
      primary.append(icon, copy);

      const statusValue = threadStatus(thread);
      const status = createElement("span", "status-badge", statusValue);
      status.dataset.status = statusValue;
      const updated = createElement("time");
      setRelativeElement(updated, firstDefined(thread?.updatedAt, thread?.lastActivityAt, thread?.createdAt));
      const action = createElement("button", "table-action", "Inspect");
      action.type = "button";
      action.disabled = !id;
      action.addEventListener("click", () => {
        state.activityThreadId = id;
        switchTab("activity", { updateHash: true, focusPanel: true });
        renderActivityThreadOptions();
        renderActivity();
        loadActivity(id);
      });
      row.append(
        createCell("Thread", primary),
        createCell("Status", status),
        createCell("Updated", updated),
        createCell("Tokens", formatCompact(threadTokens(thread))),
        createCell("Duration", formatDuration(threadDuration(thread))),
        createCell("Action", action),
      );
      list?.append(row);
    });
    toggleHidden("threads-empty", state.threads.items.length > 0 || state.threads.loading);
    toggleHidden(list, state.threads.items.length === 0);
    updateThreadPagination();
  }

  function updateThreadPagination() {
    const count = state.threads.items.length;
    const start = count ? state.threads.offset + 1 : 0;
    const end = state.threads.offset + count;
    const totalText = state.threads.total === null ? `${start}–${end}` : `${start}–${end} of ${integerFormatter.format(state.threads.total)}`;
    setText("thread-page-label", count ? `Showing ${totalText}` : "No threads to show");
    setText("thread-result-count", state.threads.total === null
      ? `${formatInteger(count)} shown`
      : `${formatInteger(state.threads.total)} result${state.threads.total === 1 ? "" : "s"}`);
    const previous = $("#thread-prev");
    const next = $("#thread-next");
    if (previous) previous.disabled = state.threads.loading || state.threads.offset <= 0;
    if (next) next.disabled = state.threads.loading || !state.threads.hasMore;
  }

  function safeRelativePath(value) {
    const raw = cleanText(value, "").replace(/\\/g, "/");
    if (!raw) return "";
    if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.includes("\0")) return null;
    const parts = raw.split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === "..")) return null;
    return parts.join("/");
  }

  function safeChildPath(parent, name) {
    const safeParent = safeRelativePath(parent);
    const safeName = safeRelativePath(name);
    if (safeParent === null || safeName === null || !safeName || safeName.includes("/")) return null;
    return safeParent ? `${safeParent}/${safeName}` : safeName;
  }

  async function loadFiles({ path = state.files.path, offset = state.files.offset } = {}) {
    const safePath = safeRelativePath(path);
    if (safePath === null) {
      setInlineMessage("files-message", "Unsafe directory path rejected by the browser.");
      return;
    }
    state.files.controller?.abort();
    const controller = new AbortController();
    state.files.controller = controller;
    state.files.loading = true;
    setInlineMessage("files-message", "Loading directory metadata…", "info");
    $("#file-prev")?.setAttribute("disabled", "");
    $("#file-next")?.setAttribute("disabled", "");
    const parameters = new URLSearchParams({
      scope: "codex",
      path: safePath,
      offset: String(Math.max(0, offset)),
      limit: String(DEFAULT_FILE_PAGE_SIZE),
    });
    try {
      const payload = await apiFetch(`/api/files?${parameters}`, { signal: controller.signal });
      if (state.files.controller !== controller) return;
      const items = collectionFromPayload(payload, ["entries", "files", "items", "results", "data"]);
      const total = payloadTotal(payload);
      const responsePath = safeRelativePath(firstDefined(payload?.path, payload?.relativePath, safePath));
      const responseOffset = firstNumber(payload?.offset, payload?.pagination?.offset, offset) || 0;
      const responseLimit = firstNumber(payload?.limit, payload?.pagination?.limit);
      const explicitHasMore = firstDefined(payload?.hasMore, payload?.pagination?.hasMore);
      const nextOffset = firstNumber(payload?.nextOffset, payload?.pagination?.nextOffset);
      state.files.items = items;
      state.files.total = total;
      state.files.path = responsePath === null ? safePath : responsePath;
      state.files.offset = responseOffset;
      state.files.pageSize = responseLimit || (items.length > 0 ? items.length : state.files.pageSize);
      state.files.nextOffset = nextOffset;
      state.files.scanLimited = payload?.scanLimited === true;
      state.files.hasMore = typeof explicitHasMore === "boolean"
        ? explicitHasMore
        : nextOffset !== null ? true
          : total !== null ? responseOffset + items.length < total
            : items.length >= DEFAULT_FILE_PAGE_SIZE;
      state.files.loaded = true;
      setInlineMessage("files-message", state.files.scanLimited
        ? "This directory exceeds the 10,000-entry safety limit; the listing and count are partial."
        : "", "info");
      renderFiles();
    } catch (error) {
      if (error?.name !== "AbortError") {
        setInlineMessage("files-message", readableError(error));
        if (!state.files.loaded) {
          state.files.items = [];
          renderFiles();
        }
      }
    } finally {
      if (state.files.controller === controller) {
        state.files.loading = false;
        updateFilePagination();
      }
    }
  }

  function fileIsDirectory(file) {
    const kind = cleanText(firstDefined(file?.kind, file?.type), "").toLowerCase();
    return file?.isDirectory === true || file?.directory === true || kind === "directory" || kind === "dir" || kind === "folder";
  }

  function fileKind(file) {
    if (fileIsDirectory(file)) return "Directory";
    return cleanText(firstDefined(file?.kind, file?.type, file?.extension), "File");
  }

  function renderFiles() {
    renderBreadcrumbs();
    const list = $("#file-list");
    clearElement(list);
    state.files.items.forEach((file) => {
      const name = storageFileName(file);
      const directory = fileIsDirectory(file);
      const safePath = directory ? safeChildPath(state.files.path, name) : null;
      const row = document.createElement("tr");
      const fileButton = createElement("button", "file-link");
      fileButton.type = "button";
      fileButton.disabled = !directory || safePath === null;
      const icon = createElement("span", "file-kind-icon");
      icon.dataset.kind = directory ? "directory" : "file";
      icon.append(createSvgIcon(directory ? "folder" : "file"));
      fileButton.append(icon, createElement("span", "", name));
      if (directory && safePath !== null) {
        fileButton.setAttribute("aria-label", `Open directory ${name}`);
        fileButton.addEventListener("click", () => loadFiles({ path: safePath, offset: 0 }));
      }
      row.append(
        createCell("Name", fileButton),
        createCell("Kind", fileKind(file)),
        createCell("Size", directory && firstNumber(file?.sizeBytes, file?.bytes, file?.size) === null
          ? "—" : formatBytes(firstDefined(file?.sizeBytes, file?.bytes, file?.size))),
        createCell("Modified", formatRelative(firstDefined(file?.modifiedAt, file?.mtime, file?.updatedAt))),
      );
      list?.append(row);
    });
    toggleHidden("files-empty", state.files.items.length > 0 || state.files.loading);
    toggleHidden(list, state.files.items.length === 0);
    updateFilePagination();
  }

  function renderBreadcrumbs() {
    const breadcrumbs = $("#file-breadcrumbs");
    clearElement(breadcrumbs);
    const parts = state.files.path ? state.files.path.split("/").filter(Boolean) : [];
    const root = createElement("button", "breadcrumb-button", "Codex home");
    root.type = "button";
    if (parts.length === 0) root.setAttribute("aria-current", "page");
    else root.addEventListener("click", () => loadFiles({ path: "", offset: 0 }));
    breadcrumbs?.append(root);
    parts.forEach((part, index) => {
      const separator = createElement("span", "breadcrumb-separator", "/");
      separator.setAttribute("aria-hidden", "true");
      const button = createElement("button", "breadcrumb-button", part);
      button.type = "button";
      const path = parts.slice(0, index + 1).join("/");
      if (index === parts.length - 1) button.setAttribute("aria-current", "page");
      else button.addEventListener("click", () => loadFiles({ path, offset: 0 }));
      breadcrumbs?.append(separator, button);
    });
    const up = $("#files-up");
    if (up) up.disabled = parts.length === 0 || state.files.loading;
  }

  function updateFilePagination() {
    const count = state.files.items.length;
    const start = count ? state.files.offset + 1 : 0;
    const end = state.files.offset + count;
    setText("file-page-label", count
      ? state.files.total === null ? `Showing ${start}–${end}` : `Showing ${start}–${end} of ${formatInteger(state.files.total)}`
      : "No entries to show");
    const previous = $("#file-prev");
    const next = $("#file-next");
    if (previous) previous.disabled = state.files.loading || state.files.offset <= 0;
    if (next) next.disabled = state.files.loading || !state.files.hasMore;
    renderBreadcrumbs();
  }

  function activityCandidates() {
    const snapshot = state.snapshot || {};
    const values = [...state.activityDetails.values()];
    if (isObject(snapshot.activity)) values.push(snapshot.activity);
    values.push(...asArray(snapshot.activities).filter(isObject));
    const allThreads = [...asArray(snapshot.threads), ...state.threads.items];
    allThreads.forEach((thread) => {
      if (isObject(thread?.activity)) {
        values.push({ ...thread.activity, threadId: firstDefined(thread.activity.threadId, threadId(thread)) });
      }
    });
    return values;
  }

  async function loadActivity(threadIdValue, { silent = false } = {}) {
    const id = cleanText(threadIdValue, "");
    if (!id) {
      state.activityThreadId = "";
      renderActivity();
      return;
    }
    state.activityController?.abort();
    const controller = new AbortController();
    state.activityController = controller;
    state.activityLoading = true;
    if (!silent) setInlineMessage("activity-message", "Loading bounded activity metadata…", "info");
    try {
      const payload = await apiFetch(`/api/activity?threadId=${encodeURIComponent(id)}`, { signal: controller.signal });
      if (state.activityController !== controller) return;
      state.activityDetails.set(id, payload);
      renderActivityThreadOptions();
      renderActivity();
    } catch (error) {
      if (!silent && error?.name !== "AbortError") setInlineMessage("activity-message", readableError(error));
    } finally {
      if (state.activityController === controller) state.activityLoading = false;
    }
  }

  function selectedActivity() {
    if (!state.activityThreadId) {
      return isObject(state.snapshot?.activity) ? state.snapshot.activity : null;
    }
    const activities = activityCandidates();
    return activities.find((activity) => cleanText(firstDefined(activity.threadId, activity.id), "") === state.activityThreadId) || null;
  }

  function activityTokenUsage(activity) {
    return isObject(activity?.tokenUsage) ? activity.tokenUsage : isObject(activity?.usage) ? activity.usage : {};
  }

  function renderActivityThreadOptions() {
    const select = $("#activity-thread-select");
    if (!select) return;
    const currentValue = state.activityThreadId;
    clearElement(select);
    const latest = createElement("option", "", "Latest observed");
    latest.value = "";
    select.append(latest);
    const seen = new Set();
    const allThreads = [...asArray(state.snapshot?.threads), ...state.threads.items];
    allThreads.forEach((thread) => {
      const id = threadId(thread);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const option = createElement("option", "", `${threadTitle(thread)} · ${shortId(id)}`);
      option.value = id;
      select.append(option);
    });
    activityCandidates().forEach((activity) => {
      const id = cleanText(firstDefined(activity.threadId, activity.id), "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      const option = createElement("option", "", `Thread ${shortId(id)}`);
      option.value = id;
      select.append(option);
    });
    if (currentValue && !seen.has(currentValue)) {
      const option = createElement("option", "", `Thread ${shortId(currentValue)}`);
      option.value = currentValue;
      select.append(option);
    }
    select.value = currentValue;
  }

  function eventType(event, index) {
    if (!isObject(event)) return cleanText(event, `Event ${index + 1}`);
    return cleanText(firstDefined(event.type, event.eventType, event.name, event.kind), `Event ${index + 1}`);
  }

  function eventStatus(event) {
    return cleanText(firstDefined(event?.status, event?.state), "observed").toLowerCase();
  }

  function eventTimestamp(event) {
    const date = parseDate(firstDefined(event?.occurredAt, event?.timestamp, event?.createdAt, event?.startedAt, event?.time));
    return date ? date.getTime() : 0;
  }

  function renderActivity() {
    if (!state.snapshot) return;
    const activity = selectedActivity();
    const missingSelected = Boolean(state.activityThreadId && !activity);
    const unavailable = isObject(activity) && activity.available === false;
    const noCompleteRecords = activity?.parse?.noCompleteRecords === true;
    const activityMetricsAvailable = Boolean(activity) && !unavailable && !noCompleteRecords;
    setInlineMessage("activity-message", missingSelected
      ? "Detailed activity metadata is not present in the current snapshot for this thread."
      : unavailable ? cleanText(activity.reason, "Activity metadata is unavailable.")
        : noCompleteRecords ? "No complete metadata record fits inside the bounded rollout tail; activity counters are unknown."
          : "", "info");
    const events = asArray(activity?.events);
    const tools = asArray(activity?.tools);
    const toolCalls = tools.reduce((sum, tool) => sum + (firstNumber(tool?.count, tool?.calls, tool?.invocations) || 1), 0);
    const usage = activityTokenUsage(activity);
    const context = isObject(activity?.contextWindow) ? activity.contextWindow : {};
    const id = cleanText(firstDefined(activity?.threadId, activity?.id, state.activityThreadId), "—");
    const input = firstNumber(usage.inputTokens, usage.input, usage.promptTokens);
    const output = firstNumber(usage.outputTokens, usage.output, usage.completionTokens);
    const cached = firstNumber(usage.cachedInputTokens, usage.cachedInput, usage.cachedTokens);
    const reasoning = firstNumber(usage.reasoningOutputTokens, usage.reasoningTokens);
    const total = tokenTotal(usage);
    const used = firstNumber(context.usedTokens, context.used, context.tokens, activity?.contextTokens, activity?.lastTokenUsage?.totalTokens);
    const limit = firstNumber(context.maxTokens, context.limit, context.window, activity?.contextLimit, isObject(activity?.contextWindow) ? null : activity?.contextWindow);
    const contextPercent = firstNumber(context.percent, context.percentage, context.utilizationPercent)
      ?? (used !== null && limit ? (used / limit) * 100 : null);
    setText("activity-thread-id", id);
    const threadIdElement = $("#activity-thread-id");
    if (threadIdElement) threadIdElement.title = id === "—" ? "" : id;
    setText("activity-token-total", formatCompact(total));
    setText("activity-token-detail", `Input ${formatCompact(input)} · Output ${formatCompact(output)} · Cached ${formatCompact(cached)} · Reasoning ${formatCompact(reasoning)}`);
    setText("activity-context", contextPercent === null ? formatCompact(used) : formatPercent(contextPercent));
    setText("activity-context-detail", limit === null ? "Window unavailable" : `${formatCompact(used)} of ${formatCompact(limit)} tokens`);
    setText("activity-event-count", activityMetricsAvailable ? formatInteger(events.length) : "—");
    setText("activity-tool-count", activityMetricsAvailable ? `${formatInteger(toolCalls)} tool calls` : "Unavailable");
    const turns = isObject(activity?.turns) ? activity.turns : {};
    const turnRuntimeMs = firstNumber(turns.runtimeMs, activity?.runtimeMs);
    const medianTtftMs = firstNumber(turns.medianTimeToFirstTokenMs, activity?.medianTimeToFirstTokenMs);
    const completedTurns = firstNumber(turns.completed, turns.sample);
    setText("activity-runtime", turnRuntimeMs === null ? "—" : formatDuration(turnRuntimeMs / 1_000));
    setText("activity-runtime-detail", turnRuntimeMs === null
      ? "Timing unavailable"
      : `${formatInteger(completedTurns)} completed · median TTFT ${medianTtftMs === null ? "—" : formatDuration(medianTtftMs / 1_000)}`);

    const eventList = $("#activity-event-list");
    clearElement(eventList);
    events.slice().sort((left, right) => eventTimestamp(right) - eventTimestamp(left)).slice(0, 30).forEach((event, index) => {
      const item = isObject(event) ? event : { type: event };
      const status = eventStatus(item);
      const row = createElement("li", "event-item");
      row.dataset.status = status;
      const dot = createElement("span", "event-dot");
      dot.setAttribute("aria-hidden", "true");
      const body = createElement("span", "event-body");
      body.append(
        createElement("strong", "", eventType(item, index)),
        createElement("small", "", `${formatKey(status)}${firstNumber(item.durationMs) !== null ? ` · ${formatDuration(firstNumber(item.durationMs) / 1_000)}` : ""}`),
      );
      const label = firstDefined(item.label, item.type, item.eventType, item.name, item.kind);
      body.querySelector("strong").textContent = cleanText(label, eventType(item, index));
      const time = createElement("time", "event-time");
      setRelativeElement(time, firstDefined(item.occurredAt, item.timestamp, item.createdAt, item.startedAt, item.time));
      row.append(dot, body, time);
      eventList?.append(row);
    });
    toggleHidden("activity-events-empty", events.length > 0);
    setText($("#activity-events-empty p"), activityMetricsAvailable
      ? "No operational events are available for this thread."
      : "Operational event counters are unavailable for this thread.");

    const toolList = $("#activity-tool-list");
    clearElement(toolList);
    tools.slice(0, 30).forEach((tool, index) => {
      const item = isObject(tool) ? tool : { name: tool };
      const name = cleanText(firstDefined(item.name, item.tool, item.type, item.kind), `Tool ${index + 1}`);
      const count = firstNumber(item.count, item.calls, item.invocations);
      const status = cleanText(firstDefined(item.status, item.state), count === null ? "Observed call" : "Calls");
      const duration = firstNumber(item.durationMs, item.totalDurationMs);
      const row = createElement("div", "tool-row");
      row.append(
        createElement("span", "tool-icon", name.slice(0, 2).toLowerCase()),
        (() => {
          const copy = createElement("span", "tool-copy");
          copy.append(
            createElement("strong", "", name),
            createElement("small", "", `${formatKey(status)}${duration === null ? "" : ` · ${formatDuration(duration / 1_000)}`}`),
          );
          return copy;
        })(),
        createElement("span", "tool-count", count === null ? "1×" : `${formatInteger(count)}×`),
      );
      toolList?.append(row);
    });
    toggleHidden("activity-tools-empty", tools.length > 0);
    setText($("#activity-tools-empty p"), activityMetricsAvailable
      ? "No tool-call metadata is available for this thread."
      : "Tool-call counters are unavailable for this thread.");
  }

  function renderAbout() {
    const sources = asArray(state.snapshot.sources);
    const list = $("#source-list");
    clearElement(list);
    sources.forEach((source, index) => {
      const item = isObject(source) ? source : { name: source };
      const name = cleanText(firstDefined(item.name, item.type, item.id), `Source ${index + 1}`);
      const secondary = cleanText(firstDefined(item.path, item.scope, item.updatedAt ? `Updated ${formatRelative(item.updatedAt)}` : null), "Local metadata source");
      const row = createElement("li", "source-item");
      row.append(
        createElement("span", "source-icon", name.slice(0, 2).toLowerCase()),
        (() => {
          const copy = createElement("span", "source-copy");
          copy.append(createElement("strong", "", name), createElement("small", "mono", secondary));
          return copy;
        })(),
        createElement("span", "source-status", cleanText(firstDefined(item.status, item.available === false ? "Unavailable" : "Available"))),
      );
      list?.append(row);
    });
    toggleHidden("sources-empty", sources.length > 0);

    const privacy = isObject(state.snapshot.privacy) ? state.snapshot.privacy : {};
    const privacyList = $("#privacy-list");
    clearElement(privacyList);
    const safeEntries = Object.entries(privacy).filter(([key, value]) => {
      const sensitiveKey = /(token|secret|password|credential|header|cookie|prompt|message|content|body)/i.test(key);
      return !sensitiveKey && (typeof value === "string" || typeof value === "number" || typeof value === "boolean");
    });
    safeEntries.forEach(([key, value]) => {
      const row = document.createElement("div");
      row.append(createElement("dt", "", formatKey(key)), createElement("dd", "", typeof value === "boolean" ? (value ? "Yes" : "No") : cleanText(value)));
      privacyList?.append(row);
    });
    toggleHidden("privacy-list", safeEntries.length === 0);
    toggleHidden("privacy-fallback", safeEntries.length > 0);
  }

  function switchTab(tab, { updateHash = false, focusPanel = false } = {}) {
    const nextTab = TAB_ORDER.includes(tab) ? tab : "overview";
    state.activeTab = nextTab;
    $$("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === nextTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$("[data-view]").forEach((view) => {
      const active = view.dataset.view === nextTab;
      view.hidden = !active;
      view.classList.toggle("is-active", active);
    });
    const [title, subtitle] = TAB_COPY[nextTab];
    setText("page-title", title);
    setText("page-subtitle", subtitle);
    document.title = nextTab === "overview" ? "Xedoc — Codex, in plain sight." : `${title} — Xedoc`;
    if (updateHash && window.location.hash !== `#${nextTab}`) history.pushState(null, "", `#${nextTab}`);
    if (updateHash) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (nextTab === "overview" && !state.resetHistory.loaded) loadResetHistory();
    if (nextTab === "insights" && !state.insights.loaded) loadInsights();
    if (nextTab === "threads" && !state.threads.loaded) loadThreads();
    if (nextTab === "storage" && !state.files.loaded) loadFiles({ path: "", offset: 0 });
    if (nextTab === "activity") renderActivity();
    if (focusPanel) document.getElementById(`view-${nextTab}`)?.focus({ preventScroll: true });
  }

  async function manualRefresh() {
    const button = $("#refresh-button");
    if (button?.disabled) return;
    if (button) button.disabled = true;
    const jobs = [loadSnapshot({ manual: true })];
    if (state.activeTab === "overview") jobs.push(loadResetHistory());
    if (state.activeTab === "insights") jobs.push(loadInsights());
    if (state.activeTab === "threads") jobs.push(loadThreads());
    if (state.activeTab === "storage") jobs.push(loadFiles());
    await Promise.allSettled(jobs);
    if (button) button.disabled = false;
  }

  function bindEvents() {
    $$("[data-tab]").forEach((button, index) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab, { updateHash: true }));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let nextIndex = index;
        if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = TAB_ORDER.length - 1;
        else if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % TAB_ORDER.length;
        else nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        const tab = TAB_ORDER[nextIndex];
        switchTab(tab, { updateHash: true });
        $(`[data-tab='${tab}']`)?.focus();
      });
    });
    $$('[data-go-tab]').forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.goTab, { updateHash: true, focusPanel: true }));
    });
    $("#refresh-button")?.addEventListener("click", manualRefresh);
    $("#thread-search")?.addEventListener("input", (event) => {
      window.clearTimeout(state.threadDebounce);
      toggleHidden("thread-search-spinner", false);
      state.threadDebounce = window.setTimeout(() => {
        const query = event.target.value.trim();
        state.threads.offset = 0;
        state.threads.query = query;
        loadThreads({ offset: 0, query });
      }, 320);
    });
    $("#thread-search")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      window.clearTimeout(state.threadDebounce);
      const query = event.currentTarget.value.trim();
      loadThreads({ offset: 0, query });
    });
    $("#thread-clear")?.addEventListener("click", () => {
      window.clearTimeout(state.threadDebounce);
      const input = $("#thread-search");
      if (input) input.value = "";
      loadThreads({ offset: 0, query: "" });
      input?.focus();
    });
    $("#thread-prev")?.addEventListener("click", () => loadThreads({ offset: Math.max(0, state.threads.offset - THREAD_LIMIT) }));
    $("#thread-next")?.addEventListener("click", () => loadThreads({ offset: state.threads.offset + THREAD_LIMIT }));
    $("#files-up")?.addEventListener("click", () => {
      const parts = state.files.path.split("/").filter(Boolean);
      parts.pop();
      loadFiles({ path: parts.join("/"), offset: 0 });
    });
    $("#file-prev")?.addEventListener("click", () => loadFiles({ offset: Math.max(0, state.files.offset - state.files.pageSize) }));
    $("#file-next")?.addEventListener("click", () => {
      const nextOffset = state.files.nextOffset ?? state.files.offset + Math.max(state.files.items.length, state.files.pageSize);
      loadFiles({ offset: nextOffset });
    });
    $("#activity-thread-select")?.addEventListener("change", (event) => {
      state.activityThreadId = event.target.value;
      renderActivity();
      loadActivity(event.target.value);
    });
    window.addEventListener("popstate", () => switchTab(window.location.hash.slice(1)));
    window.addEventListener("hashchange", () => switchTab(window.location.hash.slice(1)));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        window.clearTimeout(state.pollTimer);
      } else {
        loadSnapshot();
      }
    });
  }

  function initialize() {
    bootstrapApiToken();
    bindEvents();
    const initialTab = window.location.hash.slice(1);
    switchTab(TAB_ORDER.includes(initialTab) ? initialTab : "overview");
    state.relativeTimer = window.setInterval(refreshRelativeTimes, 15_000);
    loadSnapshot();
  }

  initialize();
})();
