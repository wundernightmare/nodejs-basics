/**
 * Watches a Secret-mounted file for hot rotation.
 *
 * K8s Secret rotation pattern: kubelet projects each Secret key as a file
 * under `/var/secrets/...`. Kubelet performs an atomic symlink swap on
 * rotation — the file appears to change in place, the underlying inode
 * is replaced. Polling content beats fs.watch here: fs.watch on the
 * symlink is unreliable across CSI plugins and kubelet versions, while
 * a 5–30 s poll catches every rotation cheaply.
 *
 * Use sites:
 *   - DATABASE_PASSWORD_FILE — pg.Pool's `password` accepts a function,
 *     so new connections pick up the rotated secret without a pod
 *     restart.
 *   - KAFKA_SASL_PASSWORD_FILE — librdkafka does not support credential
 *     rotation at runtime; SecretFileWatcher detects the rotation so
 *     operators can pair it with Stakater Reloader (or a manual rollout
 *     restart) to apply the change.
 *
 * The watcher trims trailing whitespace from the file content — kubectl
 * + base64 round-trips frequently end with a stray newline.
 */
import { readFileSync, statSync } from "node:fs";

import { pinoLogger } from "@base/logger";

const logger = pinoLogger.child({ "log.logger": "SecretFileWatcher" });

export interface SecretFileWatcherOptions {
  /** Absolute path to the Secret-mounted file. */
  path: string;
  /** Identifier surfaced in logs / events. */
  name: string;
  /**
   * Poll interval. 30 s is the sweet spot for K8s Secret rotation —
   * kubelet's own re-projection latency is bounded at sync-frequency
   * (default 60 s); polling at half that gives one detection within
   * a sync cycle without burning CPU.
   */
  pollIntervalMs?: number;
}

export type SecretChangeListener = (next: string, prev: string) => void;

export class SecretFileWatcher {
  readonly #path: string;
  readonly #name: string;
  readonly #pollIntervalMs: number;
  readonly #listeners = new Set<SecretChangeListener>();
  #current: string;
  #lastMtimeMs: number;
  #timer?: NodeJS.Timeout;

  constructor(opts: SecretFileWatcherOptions) {
    this.#path = opts.path;
    this.#name = opts.name;
    this.#pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.#current = SecretFileWatcher.#read(this.#path);
    this.#lastMtimeMs = SecretFileWatcher.#mtimeMs(this.#path);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      try {
        this.#poll();
      } catch (err) {
        logger.warn({ err, "secret.name": this.#name }, "SecretFileWatcher poll failed");
      }
    }, this.#pollIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#listeners.clear();
  }

  current(): string {
    return this.#current;
  }

  onChange(cb: SecretChangeListener): () => void {
    this.#listeners.add(cb);
    return (): void => {
      this.#listeners.delete(cb);
    };
  }

  #poll(): void {
    const mtimeMs = SecretFileWatcher.#mtimeMs(this.#path);
    if (mtimeMs === this.#lastMtimeMs) return;

    const next = SecretFileWatcher.#read(this.#path);
    this.#lastMtimeMs = mtimeMs;

    if (next === this.#current) return;

    const prev = this.#current;
    this.#current = next;
    logger.info({ "secret.name": this.#name }, "Secret rotation detected");
    for (const cb of this.#listeners) {
      try {
        cb(next, prev);
      } catch (err) {
        logger.warn(
          { err, "secret.name": this.#name },
          "SecretFileWatcher listener threw — continuing",
        );
      }
    }
  }

  static #read(path: string): string {
    return readFileSync(path, "utf8").replace(/\r?\n+$/, "");
  }

  static #mtimeMs(path: string): number {
    return statSync(path).mtimeMs;
  }
}
