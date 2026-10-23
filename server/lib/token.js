import crypto from "node:crypto";
import zlib from "node:zlib";
import { config } from "../config.js";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Signed, deflate-compressed, stateless token for /p/<token>.
 */
export function sign(payload, ttlSec = config.tokenTtlSec) {
  const body = { ...payload, e: Math.floor(Date.now() / 1000) + ttlSec };
  const packed = zlib.deflateRawSync(Buffer.from(JSON.stringify(body))).toString("base64url");
  const mac = crypto.createHmac("sha256", config.tokenSecret).update(packed).digest("base64url");
  return `${packed}.${mac}`;
}

/** @returns {object|null} payload, or null when invalid/expired */
export function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [packed, mac] = token.split(".");
  if (!packed || !mac) return null;

  const expected = crypto
    .createHmac("sha256", config.tokenSecret)
    .update(packed)
    .digest("base64url");

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let body;
  try {
    body = JSON.parse(zlib.inflateRawSync(Buffer.from(packed, "base64url")).toString());
  } catch {
    return null;
  }
  if (!body.e || body.e < Math.floor(Date.now() / 1000)) return null;
  return body;
}

export { b64url };
