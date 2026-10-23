/**
 * One error, one readable line.
 *
 * Node's fetch wraps the real OS/socket reason on `err.cause`. `describeError`
 * keeps the outer context and appends the underlying code/host/status.
 */

const CAUSE_KEYS = ["code", "errno", "syscall", "hostname", "address"];

function causeDetail(cause) {
  if (!cause || typeof cause !== "object") {
    return typeof cause === "string" ? cause : "";
  }
  const parts = [];
  for (const key of CAUSE_KEYS) {
    const v = cause[key];
    if (v === undefined || v === null || v === "") continue;
    if (key === "errno" && cause.code) continue;
    parts.push(String(v));
  }
  if (!parts.length && typeof cause.message === "string") parts.push(cause.message);
  return parts.join(" ");
}

export function describeError(err) {
  if (!err) return "unknown error";
  const base = typeof err === "string" ? err : err.message || String(err);
  const parts = [base];

  const cause = typeof err === "object" ? err.cause : undefined;
  const detail = causeDetail(cause);
  if (detail && !base.includes(detail)) parts.push(`(${detail})`);

  const code = typeof err === "object" ? err.code : undefined;
  if (code && !base.includes(String(code))) parts.push(`[${code}]`);

  const status = typeof err === "object" ? err.response?.status : undefined;
  if (status && !base.includes(String(status))) parts.push(`HTTP ${status}`);

  return parts.join(" ");
}
