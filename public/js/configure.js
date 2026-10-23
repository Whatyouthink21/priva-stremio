import {
  bindCopyButton,
  decodeBase64Url,
  encodeBase64Url,
  escapeHtml,
  formatLatency,
  statusClassFor,
  stremioUrlFor,
} from "/js/common.js";

const FALLBACK_PROVIDERS = [
  { id: "castle", displayName: "Castle TV", description: "Fast MP4/HLS streams across a broad movie & TV catalog.", defaultBudgetSec: 6, status: "ok", latencyMs: null },
  { id: "4khdhub", displayName: "4KHDHub", description: "High-bitrate multi-quality MKV releases up to 2160p via HubCloud.", defaultBudgetSec: 15, status: "ok", latencyMs: null },
  { id: "autoEmbed", displayName: "MultiStream (autoEmbed)", description: "Aggregator reaching Cinejoy, Movy and Vidstuck in parallel.", defaultBudgetSec: 10, status: "ok", latencyMs: null },
  { id: "movieBoxWeb", displayName: "MovieBox Web", description: "HLS/MP4 streams with multi-language captions.", defaultBudgetSec: 10, status: "ok", latencyMs: null },
  { id: "kissKh", displayName: "KissKH", description: "Anime and Asian drama streams in HLS with real subtitles.", defaultBudgetSec: 10, status: "ok", latencyMs: null },
];

const DEFAULT_BUDGETS = {
  castle: 6,
  autoEmbed: 10,
  movieBoxWeb: 10,
  kissKh: 10,
  "4khdhub": 15,
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cssEsc = (s) =>
  globalThis.CSS && typeof globalThis.CSS.escape === "function"
    ? globalThis.CSS.escape(s)
    : String(s).replace(/["\\]/g, "\\$&");

const els = {
  errorBanner: document.getElementById("config-error"),
  addonName: document.getElementById("addon-name"),
  nameCount: document.getElementById("name-count"),
  toggleMkv: document.getElementById("toggle-mkv"),
  toggleProxy: document.getElementById("toggle-proxy"),
  maxStreams: document.getElementById("max-streams"),
  maxStreamsOut: document.getElementById("max-streams-out"),
  globalPatience: document.getElementById("global-patience"),
  globalPatienceOut: document.getElementById("global-patience-out"),
  providerList: document.getElementById("provider-checkboxes"),
  refreshHealthBtn: document.getElementById("refresh-health-btn"),
  installBtn: document.getElementById("install-stremio-btn"),
  copyManifestBtn: document.getElementById("copy-manifest-btn"),
  copyInstallBtn: document.getElementById("copy-install-btn"),
  copyStremioBtn: document.getElementById("copy-stremio-btn"),
  manifestInput: document.getElementById("manifest-url-input"),
  presetRow: document.getElementById("preset-row"),
  testForm: document.getElementById("test-form"),
  testType: document.getElementById("test-type"),
  testId: document.getElementById("test-id"),
  runTestBtn: document.getElementById("run-test-btn"),
  testSummary: document.getElementById("test-summary"),
  testResults: document.getElementById("test-results"),
};

let catalog = [...FALLBACK_PROVIDERS];
let hadExplicitProviders = false;

const state = {
  n: "Priva",
  p: FALLBACK_PROVIDERS.map((x) => x.id),
  b: { ...DEFAULT_BUDGETS },
  mk: true,
  px: true,
  max: 20,
};

function extractInitialToken() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("config")) return params.get("config");
  const m = /^\/([^/]+)\/configure\/?$/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

function applyDecodedToken(token) {
  if (!token) return;
  try {
    const raw = decodeBase64Url(token);
    if (typeof raw.n === "string" && raw.n.trim()) {
      state.n = raw.n.trim().slice(0, 18);
    }
    if (Array.isArray(raw.p)) {
      hadExplicitProviders = true;
      state.p = raw.p.map((x) => String(x || "").trim()).filter(Boolean);
    }
    if (typeof raw.b === "number" && Number.isFinite(raw.b)) {
      const sec = clamp(Math.round(raw.b), 4, 15);
      for (const k of Object.keys(state.b)) state.b[k] = sec;
    } else if (raw.b && typeof raw.b === "object" && !Array.isArray(raw.b)) {
      for (const [k, v] of Object.entries(raw.b)) {
        const n = Number(v);
        if (Number.isFinite(n)) state.b[k] = clamp(Math.round(n), 4, 15);
      }
    }
    if (raw.mk !== undefined) state.mk = Boolean(raw.mk);
    if (raw.px !== undefined) state.px = Boolean(raw.px);
    if (Number.isFinite(Number(raw.max))) {
      state.max = clamp(Math.round(Number(raw.max)), 10, 30);
    }
  } catch (err) {
    if (els.errorBanner) {
      els.errorBanner.textContent = `Ignored invalid config in URL (${err.message}). Using default settings instead.`;
      els.errorBanner.hidden = false;
    }
  }
}

export function buildConfigPayload() {
  const budgets = {};
  for (const id of state.p) {
    budgets[id] = clamp(Math.round(Number(state.b[id] ?? DEFAULT_BUDGETS[id] ?? 8)), 4, 15);
  }
  return {
    n: (state.n || "Priva").trim().slice(0, 18) || "Priva",
    p: [...state.p],
    b: budgets,
    mk: Boolean(state.mk),
    px: Boolean(state.px),
    max: clamp(Math.round(Number(state.max) || 20), 10, 30),
  };
}

export function currentUrls() {
  const encoded = encodeBase64Url(buildConfigPayload());
  const origin = window.location.origin;
  const manifestUrl = `${origin}/${encoded}/manifest.json`;
  const configureUrl = `${origin}/${encoded}/configure`;
  const stremioUrl = stremioUrlFor(manifestUrl);
  return { encoded, manifestUrl, configureUrl, stremioUrl };
}

function updateUrlsNow() {
  const { manifestUrl, stremioUrl } = currentUrls();
  if (els.manifestInput) els.manifestInput.value = manifestUrl;
  if (els.installBtn) els.installBtn.href = stremioUrl;
}

let debounceTimer = null;
function scheduleUrlUpdate(delayMs = 90) {
  clearTimeout(debounceTimer);
  if (delayMs <= 0) {
    updateUrlsNow();
    return;
  }
  debounceTimer = setTimeout(updateUrlsNow, delayMs);
}

function syncFormControls() {
  if (els.addonName) els.addonName.value = state.n;
  if (els.nameCount) els.nameCount.textContent = `${state.n.length} / 18`;
  if (els.toggleMkv) els.toggleMkv.checked = state.mk;
  if (els.toggleProxy) els.toggleProxy.checked = state.px;
  if (els.maxStreams) els.maxStreams.value = String(state.max);
  if (els.maxStreamsOut) els.maxStreamsOut.textContent = String(state.max);
}

function renderProviders() {
  if (!els.providerList) return;
  els.providerList.innerHTML = catalog
    .map((p) => {
      const checked = state.p.includes(p.id);
      const budget = clamp(Math.round(Number(state.b[p.id] ?? p.defaultBudgetSec ?? 8)), 4, 15);
      const status = p.status || "ok";
      const cls = statusClassFor(status);
      return `
        <div class="provider-item ${checked ? "" : "is-disabled"}" data-provider-row="${escapeHtml(p.id)}">
          <div class="provider-top">
            <label class="provider-check">
              <input
                type="checkbox"
                data-provider-check="${escapeHtml(p.id)}"
                ${checked ? "checked" : ""}
              />
              <span>
                <span class="provider-title">${escapeHtml(p.displayName || p.id)}</span>
                <span class="provider-id">${escapeHtml(p.id)}</span>
                <span class="provider-desc" style="display:block">${escapeHtml(p.description || "")}</span>
              </span>
            </label>
            <div class="health-meta">
              <span class="latency-tag">${escapeHtml(formatLatency(p.latencyMs))}</span>
              <span class="status-pill ${cls}">
                <span class="status-dot"></span>
                <span>${escapeHtml(status)}</span>
              </span>
            </div>
          </div>
          <div class="provider-budget">
            <label for="budget-${escapeHtml(p.id)}">Budget</label>
            <input
              id="budget-${escapeHtml(p.id)}"
              type="range"
              min="4"
              max="15"
              step="1"
              value="${budget}"
              data-provider-budget="${escapeHtml(p.id)}"
            />
            <output data-budget-out="${escapeHtml(p.id)}">${budget}s</output>
          </div>
        </div>
      `;
    })
    .join("");
}

async function refreshHealth() {
  try {
    const res = await fetch("/health", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.providers) && data.providers.length) {
      catalog = data.providers;
      for (const p of catalog) {
        if (state.b[p.id] === undefined) {
          state.b[p.id] = clamp(Number(p.defaultBudgetSec) || DEFAULT_BUDGETS[p.id] || 8, 4, 15);
        }
      }
      if (!hadExplicitProviders) {
        const defaults = catalog.filter((p) => p.enabledByDefault !== false).map((p) => p.id);
        state.p = defaults.length ? defaults : catalog.map((p) => p.id);
      }
      renderProviders();
      updateUrlsNow();
    }
  } catch {
    /* keep fallback list when offline */
  }
}

/* ------------------------------------------------------------------ */
/* Live Stream Tester                                                  */
/* ------------------------------------------------------------------ */

function parseCardInfo(stream) {
  const lines = String(stream.title || "").split("\n");
  const top = lines[0] || "";
  const rest = lines.slice(1).join(" · ");
  const isProxy = /\/p\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(stream.url || "") || /\[P\]|· proxy$/i.test(stream.name || "");
  const qMatch = /\b(\d{3,4}p)\b/i.exec(top);
  const cMatch = /\b(HLS|MP4|MKV|DASH)\b/i.exec(top);
  const sMatch = /\b(\d+(?:\.\d+)?\s*(?:GB|MB|TB))\b/i.exec(top);
  const subsCount = Array.isArray(stream.subtitles) ? stream.subtitles.length : 0;

  return {
    provider: stream.name || "source",
    quality: qMatch ? qMatch[1] : "",
    container: cMatch ? cMatch[1].toUpperCase() : "",
    size: sMatch ? sMatch[1] : "",
    isProxy,
    subsCount,
    detail: rest || top,
  };
}

function renderTestOutput(streams, stats, wallMs, { polling = false } = {}) {
  if (els.testSummary) {
    els.testSummary.hidden = false;
    const provPills = (stats?.providers || [])
      .map((p) => {
        const cls = p.pending ? "pending" : p.timedOut ? "timeout" : p.ok ? "ok" : "empty";
        const stateLabel = p.pending
          ? `resolving… (${p.ms}ms)`
          : p.timedOut
            ? `timed out (${p.ms}ms)`
            : p.ok
              ? `${p.streams} stream${p.streams === 1 ? "" : "s"} (${p.ms}ms)`
              : `${p.error || "0 streams"} (${p.ms}ms)`;
        return `<span class="diag-pill ${cls}">${escapeHtml(p.id)}: ${escapeHtml(stateLabel)}</span>`;
      })
      .join("\n          ");

    const titlePrefix = stats?.title
      ? `<strong>${escapeHtml(stats.title)}${stats.year ? ` (${escapeHtml(String(stats.year))})` : ""}</strong> · `
      : "";
    const countsParts = [];
    if (stats) {
      countsParts.push(`${stats.answered} answered`);
      if (stats.pending) countsParts.push(`${stats.pending} resolving in background`);
      if (stats.timedOut) countsParts.push(`${stats.timedOut} timed out`);
    }
    const countsNote = countsParts.length ? ` (${countsParts.join(", ")})` : "";
    const partialNote = stats?.partial
      ? ` · <span style="color:#93c5fd">${
          polling
            ? "Auto-updating live as background sources finish…"
            : "Slower providers are finishing in background."
        }</span>`
      : "";

    els.testSummary.innerHTML = `
      <div>
        ${titlePrefix}Returned <strong>${streams.length}</strong> stream row${streams.length === 1 ? "" : "s"}
        in <strong>${Math.round(wallMs)} ms</strong>${countsNote}${partialNote}
      </div>
      ${provPills ? `<div class="provider-pills">${provPills}</div>` : ""}
    `;
  }

  if (!els.testResults) return;
  if (!streams.length) {
    els.testResults.innerHTML = `
      <div class="provider-item">
        <span class="provider-desc">No playable streams matched for this ID and configuration.</span>
      </div>
    `;
    return;
  }

  els.testResults.innerHTML = streams
    .map((s, idx) => {
      const info = parseCardInfo(s);
      const badges = [
        `<span class="badge badge-provider">${escapeHtml(info.provider)}</span>`,
        info.quality ? `<span class="badge">${escapeHtml(info.quality)}</span>` : "",
        info.container ? `<span class="badge">${escapeHtml(info.container)}</span>` : "",
        info.size ? `<span class="badge">${escapeHtml(info.size)}</span>` : "",
        `<span class="badge ${info.isProxy ? "badge-proxy" : "badge-direct"}">${
          info.isProxy ? "Proxy (/p)" : "Direct"
        }</span>`,
        info.subsCount
          ? `<span class="badge">${info.subsCount} sub${info.subsCount === 1 ? "" : "s"}</span>`
          : "",
      ]
        .filter(Boolean)
        .join("\n              ");
      return `
        <div class="stream-card">
          <div class="stream-card-main">
            <div class="stream-badges">
              ${badges}
            </div>
            ${info.detail ? `<div class="stream-detail-line">${escapeHtml(info.detail)}</div>` : ""}
          </div>
          <button class="btn btn-sm" type="button" data-copy-stream="${idx}">Copy URL</button>
        </div>
      `;
    })
    .join("");

  els.testResults.querySelectorAll("[data-copy-stream]").forEach((btn) => {
    const idx = Number(btn.getAttribute("data-copy-stream"));
    bindCopyButton(btn, () => streams[idx]?.url || "");
  });
}

let activePollTimer = null;
let activeTestRunId = 0;

function stopStragglerPoll() {
  if (activePollTimer) {
    clearTimeout(activePollTimer);
    activePollTimer = null;
  }
}

async function fetchStreamAttempt(endpoint) {
  const res = await fetch(endpoint, { headers: { Accept: "application/json" } });
  let stats = null;
  const rawHeader = res.headers.get("X-Priva-Stats");
  if (rawHeader) {
    try {
      stats = JSON.parse(rawHeader);
    } catch {
      stats = null;
    }
  }
  const body = await res.json();
  return {
    streams: Array.isArray(body?.streams) ? body.streams : [],
    stats,
  };
}

async function runLiveTest(ev) {
  ev?.preventDefault();
  stopStragglerPoll();
  const runId = ++activeTestRunId;
  updateUrlsNow();

  const rawId = (els.testId?.value || "").trim();
  if (!rawId) return;

  // Auto-align type selector when ID clearly has or lacks :season:episode
  let type = els.testType?.value || "movie";
  if (rawId.includes(":") && type !== "series") {
    type = "series";
    if (els.testType) els.testType.value = "series";
  }

  const { encoded } = currentUrls();
  const endpoint = `/${encoded}/stream/${encodeURIComponent(type)}/${encodeURIComponent(rawId)}.json`;

  if (els.runTestBtn) {
    els.runTestBtn.disabled = true;
    els.runTestBtn.textContent = "Resolving…";
  }

  const started = performance.now();
  try {
    const first = await fetchStreamAttempt(endpoint);
    if (runId !== activeTestRunId) return;
    const wallMs = performance.now() - started;
    const willPoll = Boolean(first.stats?.partial);
    renderTestOutput(first.streams, first.stats, wallMs, { polling: willPoll });
    refreshHealth();

    if (willPoll) {
      let attempts = 0;
      const pollNext = () => {
        const t = setTimeout(async () => {
          if (runId !== activeTestRunId) return;
          attempts += 1;
          try {
            const next = await fetchStreamAttempt(endpoint);
            if (runId !== activeTestRunId) return;
            const totalWallMs = performance.now() - started;
            const stillPartial = Boolean(next.stats?.partial) && attempts < 10;
            renderTestOutput(next.streams, next.stats, totalWallMs, { polling: stillPartial });
            refreshHealth();
            if (stillPartial) pollNext();
          } catch {
            /* stop polling quietly if server closed */
          }
        }, 1600);
        t.unref?.();
        activePollTimer = t;
      };
      pollNext();
    }
  } catch (err) {
    if (els.testSummary) {
      els.testSummary.hidden = false;
      els.testSummary.textContent = `Request failed: ${err.message}`;
    }
  } finally {
    if (els.runTestBtn) {
      els.runTestBtn.disabled = false;
      els.runTestBtn.textContent = "Test streams";
    }
  }
}

/* ------------------------------------------------------------------ */
/* Event Wiring                                                        */
/* ------------------------------------------------------------------ */

applyDecodedToken(extractInitialToken());
syncFormControls();
renderProviders();
updateUrlsNow();

els.addonName?.addEventListener("input", () => {
  state.n = els.addonName.value.slice(0, 18);
  if (els.nameCount) els.nameCount.textContent = `${state.n.length} / 18`;
  scheduleUrlUpdate();
});

els.toggleMkv?.addEventListener("change", () => {
  state.mk = Boolean(els.toggleMkv.checked);
  scheduleUrlUpdate(0);
});

els.toggleProxy?.addEventListener("change", () => {
  state.px = Boolean(els.toggleProxy.checked);
  scheduleUrlUpdate(0);
});

els.maxStreams?.addEventListener("input", () => {
  state.max = clamp(Number(els.maxStreams.value) || 20, 10, 30);
  if (els.maxStreamsOut) els.maxStreamsOut.textContent = String(state.max);
  scheduleUrlUpdate();
});

els.globalPatience?.addEventListener("input", () => {
  const sec = clamp(Number(els.globalPatience.value) || 8, 4, 15);
  if (els.globalPatienceOut) els.globalPatienceOut.textContent = `${sec}s`;
  for (const p of catalog) state.b[p.id] = sec;
  renderProviders();
  scheduleUrlUpdate();
});

els.providerList?.addEventListener("change", (ev) => {
  const check = ev.target.closest("[data-provider-check]");
  if (!check) return;
  hadExplicitProviders = true;
  const id = check.getAttribute("data-provider-check");
  if (check.checked) {
    if (!state.p.includes(id)) state.p.push(id);
  } else {
    state.p = state.p.filter((x) => x !== id);
  }
  const row = els.providerList.querySelector(`[data-provider-row="${cssEsc(id)}"]`);
  if (row) row.classList.toggle("is-disabled", !check.checked);
  scheduleUrlUpdate(0);
});

els.providerList?.addEventListener("input", (ev) => {
  const slider = ev.target.closest("[data-provider-budget]");
  if (!slider) return;
  const id = slider.getAttribute("data-provider-budget");
  const sec = clamp(Number(slider.value) || 8, 4, 15);
  state.b[id] = sec;
  if (els.globalPatienceOut) els.globalPatienceOut.textContent = "Custom";
  const out = els.providerList.querySelector(`[data-budget-out="${cssEsc(id)}"]`);
  if (out) out.textContent = `${sec}s`;
  scheduleUrlUpdate();
});

els.presetRow?.addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-id]");
  if (!chip) return;
  els.presetRow.querySelectorAll(".preset-chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  if (els.testType) els.testType.value = chip.getAttribute("data-type") || "movie";
  if (els.testId) els.testId.value = chip.getAttribute("data-id") || "";
});

els.testForm?.addEventListener("submit", runLiveTest);
els.refreshHealthBtn?.addEventListener("click", refreshHealth);

bindCopyButton(els.copyManifestBtn, () => currentUrls().manifestUrl);
bindCopyButton(els.copyInstallBtn, () => currentUrls().configureUrl);
bindCopyButton(els.copyStremioBtn, () => currentUrls().stremioUrl);

refreshHealth();
