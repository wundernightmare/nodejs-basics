/**
 * A queue of jobs of one kind, whatever runs it: BullMQ on Valkey or pg-boss
 * on Postgres (JobsModule picks one — README "Jobs: BullMQ or pg-boss").
 * The code that enqueues and processes jobs depends on this port only.
 */
export interface JobQueue<T extends object> {
  readonly name: string;
  /**
   * Enqueue `data` once per `key`: a send with a key the queue still holds
   * (waiting, running or recently done) is dropped — a redelivered event does
   * not run twice.
   */
  send(data: T, key: string): Promise<void>;
  /** Jobs waiting to run. */
  waiting(): Promise<number>;
  /**
   * Run `handler` for each job, one at a time per process. A throw retries the
   * job (3 attempts, exponential backoff from 5 s); a job running longer than
   * 30 s is taken back and retried.
   */
  work(handler: (data: T) => Promise<void>): Promise<void>;
  /** Readiness: the backend answers. */
  ping(): Promise<void>;
  /** Stop working, finish the job in hand. */
  close(): Promise<void>;
}

const tokens = new Map<string, symbol>();

/** The injection token of the JobQueue named `name` (JobsModule.forQueues). */
export function jobQueueToken(name: string): symbol {
  let token = tokens.get(name);
  if (token === undefined) {
    token = Symbol(`JOB_QUEUE:${name}`);
    tokens.set(name, token);
  }
  return token;
}
