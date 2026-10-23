/* Shared client utilities for / and /configure (zero external dependencies) */

export function encodeBase64Url(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(token) {
  const clean = String(token || "").trim();
  if (!clean || !/^[A-Za-z0-9_-]+={0,2}$/.test(clean)) {
    throw new Error("Invalid base64url configuration string.");
  }
  const padded = clean.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((clean.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decoded configuration is not a JSON object.");
  }
  return parsed;
}

export function stremioUrlFor(httpManifestUrl) {
  return String(httpManifestUrl).replace(/^https?:\/\//i, "stremio://");
}

/**
 * Copy text to clipboard on both HTTPS and plain HTTP (execCommand fallback).
 */
export async function copyWithFallback(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to execCommand */
    }
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);

  let ok = false;
  try {
    if (typeof document.execCommand === "function") {
      ok = Boolean(document.execCommand("copy"));
    }
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}

export function bindCopyButton(btn, getText) {
  if (!btn) return;
  const original = btn.textContent;
  let timer = null;

  btn.addEventListener("click", async () => {
    const value = typeof getText === "function" ? getText() : String(getText || "");
    await copyWithFallback(value);
    btn.textContent = "Copied";
    btn.classList.add("btn-copied");
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("btn-copied");
    }, 1800);
  });
}

export function statusClassFor(status) {
  if (status === "cooling") return "status-cooling";
  if (status === "slow") return "status-slow";
  return "status-ok";
}

export function formatLatency(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "idle";
  return `${Math.round(ms)} ms`;
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
