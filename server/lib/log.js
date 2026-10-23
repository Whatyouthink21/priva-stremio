const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function threshold() {
  const raw = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level, scope, msg, extra) {
  if ((LEVELS[level] ?? 1) < threshold()) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${COLORS[level] || ""}${ts} ${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra);
}

export function logger(scope) {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
  };
}
