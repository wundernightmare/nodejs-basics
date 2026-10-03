import { customAlphabet } from "nanoid";

// URL-safe alphabet, 21 chars → ~126 bits of entropy
const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-",
  21,
);

// Human-readable IDs for X-Request-Id and error.id.
// Crockford Base32 — no ambiguous chars (I, L, O, U removed).
// 8 chars → 32^8 = ~1.1T unique values — sufficient for request/error IDs.
// Example: "X7K2P9M4", "ERR3N8G1"
const humanReadableId = customAlphabet("0123456789ABCDEFGHJKMNPQRSTVWXYZ", 8);

export function generateRequestId(): string {
  return humanReadableId();
}

export function generateErrorId(): string {
  return humanReadableId();
}

export function generateId(): string {
  return nanoid();
}
