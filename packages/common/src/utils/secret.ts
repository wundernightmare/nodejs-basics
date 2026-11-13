import { createHash, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

const FINGERPRINT_HEX = 8;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * A secret text value — a password, a token, a key — marked as one in the
 * type system. The counterpart of golang-basics' `secret.String`.
 *
 *   const token = Secret.of(config.get("ADMIN_TOKEN"));
 *   logger.info({ token }, "configured");           // "[redacted:1a2b3c4d]"
 *   headers.authorization = `Bearer ${token.expose()}`;
 *
 * Everything that renders a value — string conversion, a template literal,
 * JSON.stringify (so pino too), util.inspect / console.log — shows
 * "[redacted:<fingerprint>]", and an unset secret shows "", so "unset" stays
 * visible. The one way to the value is `expose()`: every use of a secret is a
 * line that can be grepped for and reviewed. Call it where the value is handed
 * to what needs it (a driver, a header), not earlier.
 *
 * The value sits in a private field, which neither Object.keys, a spread,
 * structuredClone nor util.inspect (showHidden included) reaches.
 *
 * It is not a vault: the string stays in process memory and in a heap
 * snapshot. It guards against the accident, not against the process.
 */
export class Secret {
  /** The unset secret. */
  static readonly unset = new Secret(undefined);

  readonly #value: string | undefined;

  private constructor(value: string | undefined) {
    this.#value = value;
  }

  /** Wraps `value` as it is (whitespace included). Empty, null and undefined are "unset". */
  static of(value: string | Secret | null | undefined): Secret {
    if (value instanceof Secret) return value;
    if (value === undefined || value === null || value === "") return Secret.unset;
    return new Secret(value);
  }

  /** The secret itself; "" when unset. */
  expose(): string {
    return this.#value ?? "";
  }

  get isSet(): boolean {
    return this.#value !== undefined;
  }

  /**
   * Whether the secret is `candidate`, in time that depends on neither value
   * nor on their lengths (both are hashed first). An unset secret equals
   * nothing, the empty string included.
   */
  equals(candidate: string | undefined): boolean {
    if (this.#value === undefined || candidate === undefined) return false;
    return timingSafeEqual(sha256(this.#value), sha256(candidate));
  }

  /**
   * The first four bytes of the SHA-256 of the secret, in hex ("" when unset)
   * — what `printf %s "$SECRET" | sha256sum | cut -c1-8` prints. It tells
   * whether a secret changed across a rotation, or whether two instances hold
   * the same one, without showing it.
   *
   * Unsalted on purpose: salted, it could not be compared between processes.
   * The cost is that 32 bits of a digest confirm an offline guess — nothing
   * for a generated token, and a human-chosen password should not be a
   * service secret anyway.
   */
  fingerprint(): string {
    if (this.#value === undefined) return "";
    return sha256(this.#value).toString("hex").slice(0, FINGERPRINT_HEX);
  }

  toString(): string {
    return this.#value === undefined ? "" : `[redacted:${this.fingerprint()}]`;
  }

  /** Redacted too: what is serialised is about to be shown. It does not round-trip. */
  toJSON(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
