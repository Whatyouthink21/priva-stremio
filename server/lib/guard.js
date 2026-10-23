import dns from "node:dns/promises";
import net from "node:net";

const PRIVATE_V4 = [
  [/^10\./, "10/8"],
  [/^127\./, "loopback"],
  [/^169\.254\./, "link-local"],
  [/^192\.168\./, "192.168/16"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "172.16/12"],
  [/^0\./, "0/8"],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "100.64/10"],
];

/**
 * Rejects non-http(s) and anything resolving into private space unless
 * explicitly allowed (e.g. same-origin test fixtures).
 */
export async function assertPublicUrl(raw, { allowHosts = [] } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("invalid URL"), { status: 400, code: "BAD_URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error(`protocol ${url.protocol} not allowed`), {
      status: 400,
      code: "BAD_PROTOCOL",
    });
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowHosts.includes(host) || allowHosts.includes(url.host)) return url;

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw Object.assign(new Error("host not allowed"), { status: 400, code: "BLOCKED_HOST" });
  }

  const literals = net.isIP(host) ? [host] : null;
  const addresses = literals || (await dns.lookup(host, { all: true })).map((a) => a.address);

  for (const addr of addresses) {
    if (net.isIPv4(addr)) {
      for (const [re, label] of PRIVATE_V4) {
        if (re.test(addr)) {
          throw Object.assign(new Error(`blocked address (${label})`), {
            status: 400,
            code: "BLOCKED_HOST",
          });
        }
      }
    } else {
      const lower = addr.toLowerCase();
      if (
        lower === "::1" ||
        lower === "::" ||
        lower.startsWith("fe80") ||
        lower.startsWith("fc") ||
        lower.startsWith("fd") ||
        lower.startsWith("::ffff:")
      ) {
        throw Object.assign(new Error("blocked address (ipv6 private)"), {
          status: 400,
          code: "BLOCKED_HOST",
        });
      }
    }
  }
  return url;
}
