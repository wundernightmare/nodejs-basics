/**
 * redact() — a copy of a value that is safe to show an operator; what
 * GET /admin/config serves. Mirrors httpx.Redact in golang-basics:
 *
 *   - the value under any key that looks like a secret (password, passwd,
 *     secret, token, api key, private key, credential) becomes "[redacted]" —
 *     so does a `*_EXTRA_PROPERTIES` escape hatch: a JSON string of driver
 *     options that may carry `sasl.password` and is not parsed here;
 *     an empty string stays empty so "unset" remains visible;
 *   - the password of any string that parses as a URL with userinfo is
 *     replaced (postgres://app:s3cret@h → postgres://app:xxxxx@h);
 *   - numbers, booleans, null and dates are left as they are.
 *
 * Objects and arrays are walked recursively; a secret key redacts its whole
 * subtree.
 */

export const REDACTED = "[redacted]";

const SECRET_KEY =
  /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|extra[_-]?properties)/i;

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
    // Object.fromEntries, not `out[key] = …`: an own "__proto__" key (what
    // JSON.parse produces for it) must stay a key, not become the prototype.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redact(item, secret || isSecretKey(key)),
      ]),
    );
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
