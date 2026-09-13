/**
 * redact() — a copy of a value that is safe to show an operator; what
 * GET /admin/config serves. Mirrors httpx.Redact in golang-basics:
 *
 *   - the value under any key that looks like a secret (password, passwd,
 *     secret, token, api key, private key, credential) becomes "[redacted]";
 *     an empty string stays empty so "unset" remains visible;
 *   - the password of any string that parses as a URL with userinfo is
 *     replaced (postgres://app:s3cret@h → postgres://app:xxxxx@h);
 *   - numbers, booleans, null and dates are left as they are.
 *
 * Objects and arrays are walked recursively; a secret key redacts its whole
 * subtree.
 */

export const REDACTED = "[redacted]";

const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;

/** Whether a key names a secret by convention. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function redact(value: unknown, secret = false): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (secret) return value === "" ? "" : REDACTED;
    return redactUrl(value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(item, secret || isSecretKey(key));
    }
    return out;
  }
  return value; // number, boolean, bigint, symbol, function: as is
}

/** Masks the password of a URL with userinfo; any other string is returned unchanged. */
export function redactUrl(value: string): string {
  if (!value.includes("://") || !value.includes("@")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.password === "") return value;
  url.password = "xxxxx";
  return url.toString();
}
