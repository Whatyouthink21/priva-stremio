import {
  bindCopyButton,
  escapeHtml,
  formatLatency,
  statusClassFor,
  stremioUrlFor,
} from "/js/common.js";

const installBtn = document.getElementById("default-install-btn");
const copyBtn = document.getElementById("copy-default-manifest");
const versionBadge = document.getElementById("addon-version");
const listEl = document.getElementById("landing-providers");

const manifestUrl = `${window.location.origin}/manifest.json`;
if (installBtn) installBtn.href = stremioUrlFor(manifestUrl);
bindCopyButton(copyBtn, () => manifestUrl);

function renderProviders(providers) {
  if (!listEl) return;
  if (!Array.isArray(providers) || !providers.length) {
    listEl.innerHTML = `<div class="provider-item"><span class="provider-desc">No providers registered yet — run <code>npm run vendor</code>.</span></div>`;
    return;
  }

  listEl.innerHTML = providers
    .map((p) => {
      const status = p.status || "ok";
      const cls = statusClassFor(status);
      return `
        <div class="provider-item">
          <div class="provider-top">
            <div>
              <span class="provider-title">${escapeHtml(p.displayName || p.id)}</span>
              <span class="provider-id">${escapeHtml(p.id)}</span>
              <p class="provider-desc">${escapeHtml(p.description || "")}</p>
            </div>
            <div class="health-meta">
              <span class="latency-tag">${escapeHtml(formatLatency(p.latencyMs))} · ${escapeHtml(String(p.defaultBudgetSec || 8))}s cap</span>
              <span class="status-pill ${cls}">
                <span class="status-dot"></span>
                <span>${escapeHtml(status)}</span>
              </span>
            </div>
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
    if (data?.version && versionBadge) versionBadge.textContent = `v${data.version}`;
    renderProviders(data?.providers || []);
  } catch {
    /* ignore transient offline state */
  }
}

refreshHealth();
