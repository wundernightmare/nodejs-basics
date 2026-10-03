/**
 * What `KafkaProducerService.send()` can fail with — one registry, so callers
 * branch on a `kind` and a `retryable` flag instead of librdkafka codes.
 *
 * Every error send() throws is a {@link KafkaSendError}. The one decision a
 * caller has to make:
 *
 *   try {
 *     await kafka.send(record);
 *   } catch (err) {
 *     if (err instanceof KafkaSendError && err.retryable) {
 *       // keep the event and send it again later (the outbox does this)
 *     } else {
 *       // the record itself is wrong — fix it or park it, retrying won't help
 *     }
 *   }
 *
 * Before an error reaches you, two layers already retried:
 *   - librdkafka retries broker-side failures (leader moves, timeouts,
 *     lost connections) until `message.timeout.ms` (30 s) — an `unavailable`
 *     you see means that budget is spent;
 *   - send() itself waits out short local back-pressure (`queue_full`,
 *     `not_connected`) for up to `waitMs` (default 5 s, never past the
 *     request's deadline) — pass `{ waitMs: 0 }` to fail fast.
 *
 * `retryable: false` (kind `rejected`) means the same record will fail the
 * same way: an outbox-style caller stops retrying it and alerts ("poison").
 */

/** librdkafka error codes send() distinguishes (lib/error.js `codes`). */
const ERR = {
  INVALID_MSG: 2,
  UNKNOWN_TOPIC_OR_PART: 3,
  LEADER_NOT_AVAILABLE: 5,
  NOT_LEADER_FOR_PARTITION: 6,
  REQUEST_TIMED_OUT: 7,
  MSG_SIZE_TOO_LARGE: 10,
  NETWORK_EXCEPTION: 13,
  TOPIC_EXCEPTION: 17,
  RECORD_LIST_TOO_LARGE: 18,
  NOT_ENOUGH_REPLICAS: 19,
  NOT_ENOUGH_REPLICAS_AFTER_APPEND: 20,
  TOPIC_AUTHORIZATION_FAILED: 29,
  CLUSTER_AUTHORIZATION_FAILED: 31,
  POLICY_VIOLATION: 44,
  KAFKA_STORAGE_ERROR: 56,
  INVALID_RECORD: 87,
  THROTTLING_QUOTA_EXCEEDED: 89,
  LOCAL_BAD_MSG: -199,
  LOCAL_TRANSPORT: -195,
  LOCAL_MSG_TIMED_OUT: -192,
  LOCAL_UNKNOWN_PARTITION: -190,
  LOCAL_UNKNOWN_TOPIC: -188,
  LOCAL_ALL_BROKERS_DOWN: -187,
  LOCAL_TIMED_OUT: -185,
  LOCAL_QUEUE_FULL: -184,
  LOCAL_AUTHENTICATION: -169,
  LOCAL_FATAL: -150,
} as const;

export interface KafkaSendErrorSpec {
  /** Same record, later: can it succeed? */
  retryable: boolean;
  /** librdkafka codes of this kind. */
  codes: readonly number[];
}

/**
 * The registry. Keys are the `kind` of a {@link KafkaSendError}. Only
 * `rejected` is not retryable: everything else is the broker, the network or
 * the deployment, and an event kept for later is never lost.
 */
export const KAFKA_SEND_ERRORS = {
  /** The producer is (re)connecting; send() waits for it up to `waitMs`. */
  not_connected: { retryable: true, codes: [] },
  /**
   * The local send queue is full (queue.buffering.max.kbytes, 64 MiB): the
   * broker is slower than the app. Back-pressure — send() waits up to
   * `waitMs` for a single-message record.
   */
  queue_full: { retryable: true, codes: [ERR.LOCAL_QUEUE_FULL] },
  /**
   * Brokers, leaders or replicas unavailable, or not acknowledged within
   * message.timeout.ms (30 s) — librdkafka already retried all of it.
   */
  unavailable: {
    retryable: true,
    codes: [
      ERR.LOCAL_MSG_TIMED_OUT,
      ERR.LOCAL_TIMED_OUT,
      ERR.REQUEST_TIMED_OUT,
      ERR.LOCAL_TRANSPORT,
      ERR.LOCAL_ALL_BROKERS_DOWN,
      ERR.LEADER_NOT_AVAILABLE,
      ERR.NOT_LEADER_FOR_PARTITION,
      ERR.NETWORK_EXCEPTION,
      ERR.NOT_ENOUGH_REPLICAS,
      ERR.NOT_ENOUGH_REPLICAS_AFTER_APPEND,
      ERR.KAFKA_STORAGE_ERROR,
      ERR.THROTTLING_QUOTA_EXCEEDED,
    ],
  },
  /**
   * The topic does not exist (and the broker does not auto-create it) or the
   * credentials / ACLs refuse the write: the deployment, not the record. It
   * goes through once an operator provisions the topic or the access.
   */
  not_provisioned: {
    retryable: true,
    codes: [
      ERR.UNKNOWN_TOPIC_OR_PART,
      ERR.LOCAL_UNKNOWN_TOPIC,
      ERR.LOCAL_UNKNOWN_PARTITION,
      ERR.TOPIC_AUTHORIZATION_FAILED,
      ERR.CLUSTER_AUTHORIZATION_FAILED,
      ERR.LOCAL_AUTHENTICATION,
    ],
  },
  /** The producer failed fatally (idempotence state) and is being replaced. */
  fatal: { retryable: true, codes: [ERR.LOCAL_FATAL] },
  /**
   * The record itself: larger than message.max.bytes, invalid, refused by a
   * broker policy, or an invalid topic name. Resending the same record fails
   * the same way — fix, split or park it.
   */
  rejected: {
    retryable: false,
    codes: [
      ERR.MSG_SIZE_TOO_LARGE,
      ERR.RECORD_LIST_TOO_LARGE,
      ERR.INVALID_MSG,
      ERR.INVALID_RECORD,
      ERR.POLICY_VIOLATION,
      ERR.LOCAL_BAD_MSG,
      ERR.TOPIC_EXCEPTION,
    ],
  },
  /** Anything not listed: retryable, so an event is kept rather than lost. */
  unknown: { retryable: true, codes: [] },
} as const satisfies Record<string, KafkaSendErrorSpec>;

export type KafkaSendErrorKind = keyof typeof KAFKA_SEND_ERRORS;

const KIND_BY_CODE = new Map<number, KafkaSendErrorKind>(
  (Object.entries(KAFKA_SEND_ERRORS) as [KafkaSendErrorKind, KafkaSendErrorSpec][]).flatMap(
    ([kind, spec]) => spec.codes.map((code): [number, KafkaSendErrorKind] => [code, kind]),
  ),
);

/** The single error type send() throws. Branch on `retryable` (or `kind`). */
export class KafkaSendError extends Error {
  readonly kind: KafkaSendErrorKind;
  readonly retryable: boolean;
  /** The librdkafka code, when the failure came from the client. */
  readonly code: number | undefined;

  constructor(
    kind: KafkaSendErrorKind,
    options: { cause?: unknown; code?: number | undefined } = {},
  ) {
    const cause = options.cause as { message?: unknown } | undefined;
    const detail = typeof cause?.message === "string" ? `: ${cause.message}` : "";
    super(`Kafka send failed (${kind})${detail}`, { cause: options.cause });
    this.name = "KafkaSendError";
    this.kind = kind;
    this.retryable = KAFKA_SEND_ERRORS[kind].retryable;
    this.code = options.code;
  }
}

/**
 * Map whatever the client threw onto the registry. A fatal error wins over
 * its code (the client is gone, whatever the cause).
 */
export function toKafkaSendError(err: unknown): KafkaSendError {
  if (err instanceof KafkaSendError) return err;
  const e = err as { code?: unknown; fatal?: unknown } | null | undefined;
  const code = typeof e?.code === "number" ? e.code : undefined;
  if (e?.fatal === true) return new KafkaSendError("fatal", { cause: err, code });
  const kind = code === undefined ? "unknown" : (KIND_BY_CODE.get(code) ?? "unknown");
  return new KafkaSendError(kind, { cause: err, code });
}
