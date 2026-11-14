/**
 * Masking of private data — one set of rules for what an operator is shown
 * (GET /admin/config, `redact()`) and for every log record (`maskLogRecord()`,
 * installed as pino's `formatters.log`). The rules are golang-basics'
 * (libs/httpx/redact.go, logformat.go):
 *
 *   by key    a value under a key that looks like a secret becomes
 *             "[redacted]". The match is a substring, case-insensitive, and
 *             over-redacts on purpose (`auth` also takes `author`): a line
 *             with one field too few is cheaper than a leaked credential.
 *             Name your own log fields accordingly. LOG_REDACT_KEYS adds exact
 *             key names for data of the domain (`email`, `iban`).
 *   by shape  in any other string: the password of a URL with userinfo
 *             (postgres://app:s3cret@h → postgres://app:xxxxx@h), a query
 *             parameter named like a secret (?token=… → ?token=[redacted]),
 *             and a keyword DSN pair (password=… → password=[redacted]) —
 *             also inside a longer text, such as an error message.
 *   never     numbers, booleans, null, dates and the empty string: `"unset"`
 *             stays visibly unset, and `max_tokens: 4096` stays a number.
 *
 * Objects and arrays are walked; a secret key redacts its whole subtree. A
 * value that serializes itself (`toJSON`: a `Secret`, a `Buffer`) is left to
 * do so. The log message is never rewritten.
 */

export const REDACTED = "[redacted]";

const SECRET_KEY =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_.-]?key|credential|dsn|auth|cert|key[_.-]?pem|keystore|passphrase|cookie|extra[_-]?properties)/iu;

/** `scheme://user:password@` anywhere in a text; the password runs to the last `@` of the token. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]*):([^\s/?#]*)@/giu;

/** A query parameter whose name ends like a secret's — in a URL or a bare query string. */
const SECRET_PARAM =
  /((?:^|[?&])[^=&#\s]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|sslkey|auth))=([^&#\s]*)/giu;

/** `password=…` in a keyword DSN (libpq, ODBC); the value may be single-quoted. */
const DSN_PAIR = /\b(password|passwd|pwd|sslpassword)=('(?:[^'\\]|\\.)*'|[^\s&;]+)/giu;

/** What a `Secret` prints for itself. */
const FINGERPRINTED = /^\[redacted:[0-9a-f]{1,16}\]$/u;

/** How deep a log record is walked; below that a value is written as it is. */
const MAX_DEPTH = 8;
/** Key lookups are cached; a service logs a few hundred distinct keys at most. */
const MAX_CACHED_KEYS = 4096;

/** Whether a key names a secret by convention. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Masks credentials inside a string: URL passwords, secret query parameters, DSN passwords. */
export function redactUrl(value: string): string {
  if (value.includes("://")) {
    const masked = value.includes("@") ? value.replace(URL_USERINFO, "$1:xxxxx@") : value;
    return masked.includes("=") ? masked.replace(SECRET_PARAM, `$1=${REDACTED}`) : masked;
  }
  if (!value.includes("=")) return value;
  return value.replace(DSN_PAIR, `$1=${REDACTED}`).replace(SECRET_PARAM, `$1=${REDACTED}`);
}

/** Masks secret parameters of a bare query string (`page=2&token=abc`, no leading `?`). */
export function redactQuery(query: string): string {
  return query.includes("=") ? query.replace(SECRET_PARAM, `$1=${REDACTED}`) : query;
}

export function redact(value: unknown, secret = false): unknown {
  return walk(value, secret, isSecretKey, 0, undefined);
}

/** Parses LOG_REDACT_KEYS: comma-separated exact key names, case-insensitive. */
export function parseRedactKeys(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((key) => key.trim().toLowerCase())
      .filter((key) => key !== ""),
  );
}

/**
 * The masking applied to every log record: `redact()` plus the exact key
 * names of LOG_REDACT_KEYS. Returns the record itself when nothing changed
 * (the common case allocates nothing but the walk).
 */
export function logRecordMasker(
  extraKeys: ReadonlySet<string> = new Set(),
): (record: Record<string, unknown>) => Record<string, unknown> {
  const cache = new Map<string, boolean>();
  const sensitive = (key: string): boolean => {
    const known = cache.get(key);
    if (known !== undefined) return known;
    const result = isSecretKey(key) || extraKeys.has(key.toLowerCase());
    if (cache.size < MAX_CACHED_KEYS) cache.set(key, result);
    return result;
  };
  return (record) => walk(record, false, sensitive, 0, new WeakSet()) as Record<string, unknown>;
}

function walk(
  value: unknown,
  secret: boolean,
  sensitive: (key: string) => boolean,
  depth: number,
  seen: WeakSet<object> | undefined,
): unknown {
  if (typeof value === "string") {
    // Already masked at the source (a Secret's rendering, the config
    // snapshot): the fingerprint is the useful part — keep it.
    if (secret) return value === "" || FINGERPRINTED.test(value) ? value : REDACTED;
    return redactUrl(value);
  }
  if (typeof value !== "object" || value === null) return value; // number, boolean, bigint, undefined…
  if (value instanceof Date) return value;
  if (value instanceof URL) return secret ? REDACTED : redactUrl(value.toString());
  if (value instanceof Error) return secret ? REDACTED : maskError(value);
  // Serializes itself: a Secret prints its fingerprint, a Buffer its bytes.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return secret && !isSelfRedacting(value) ? REDACTED : value;
  }
  if (depth >= MAX_DEPTH) return secret ? REDACTED : value;
  if (seen !== undefined) {
    if (seen.has(value)) return value; // a cycle: the serializer deals with it
    seen.add(value);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item: unknown) => {
      const masked = walk(item, secret, sensitive, depth + 1, seen);
      if (masked !== item) changed = true;
      return masked;
    });
    return changed ? out : value;
  }

  let changed = false;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const masked = walk(item, secret || sensitive(key), sensitive, depth + 1, seen);
    if (masked !== item) changed = true;
    return [key, masked] as const;
  });
  // Object.fromEntries, not `out[key] = …`: an own "__proto__" key (what
  // JSON.parse produces for it) must stay a key, not become the prototype.
  return changed ? Object.fromEntries(entries) : value;
}

/** A `Secret` (or anything shaped like it) already prints "[redacted:<fingerprint>]". */
function isSelfRedacting(value: object): boolean {
  return typeof (value as { expose?: unknown }).expose === "function";
}

/** An error whose message or stack carries a credential is logged as a masked copy. */
function maskError(err: Error): Error {
  const message = redactUrl(err.message);
  const stack = err.stack === undefined ? undefined : redactUrl(err.stack);
  if (message === err.message && stack === err.stack) return err;
  const copy = Object.create(Object.getPrototypeOf(err) as object) as Error;
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(err));
  Object.defineProperty(copy, "message", { value: message, enumerable: false, writable: true });
  if (stack !== undefined) {
    Object.defineProperty(copy, "stack", { value: stack, enumerable: false, writable: true });
  }
  return copy;
}
