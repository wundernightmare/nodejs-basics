import { status } from "@grpc/grpc-js";

/**
 * One outbound gRPC dependency. An omitted key keeps its default; **zero
 * means disabled**, never "use the default" (the convention of golang-basics'
 * grpcx, whose YAML keys these mirror in camelCase and milliseconds).
 */
export interface GrpcTargetConfig {
  /** Logical name: the `target` metric label and the lookup key. Required, unique. */
  name: string;
  /** A gRPC target URI: `dns:///billing.internal:443`, `host:port`, `unix:…`. Required. */
  address: string;
  /** Plaintext instead of TLS with the system roots. Default: false. */
  insecure?: boolean;
  /** Whole call, retries included; a caller's shorter deadline wins. 0 = only the caller's. Default: 5000. */
  timeoutMs?: number;
  /** Queue calls while the connection is down instead of failing them. Default: false. */
  waitForReady?: boolean;
  /** Default: round_robin. */
  loadBalancing?: "round_robin" | "pick_first";
  keepalive?: {
    /** Ping an idle connection this often. 0 = off (default); else ≥ 10 000, agreed with the server. */
    timeMs?: number;
    /** Close the connection when a ping is not answered in time. Default: 20 000. */
    timeoutMs?: number;
  };
  retry?: {
    /** Total attempts, the first included; ≤ 5 (gRPC's cap). 0 or 1 = no retries. Default: 3. */
    maxAttempts?: number;
    /** Doubles per retry, ±20 % jitter (gRPC's). Default: 100. */
    baseDelayMs?: number;
    /** Default: 5000. */
    maxDelayMs?: number;
    /** Canonical status names. Default: ["UNAVAILABLE"]. */
    codes?: string[];
    /** Empty = every method; else `pkg.Service` or `pkg.Service/Method`. Default: []. */
    methods?: string[];
    /** Token bucket per channel: retries stop while it is at most half full. */
    throttle?: {
      /** ≤ 1000; 0 = no throttling. Default: 10. */
      maxTokens?: number;
      /** Tokens a successful call returns (a failed one takes 1). Default: 0.1. */
      tokenRatio?: number;
    };
  };
  circuitBreaker?: {
    /** Opens when MORE than this share of the window's calls failed; [0, 1). 0 = no breaker. Default: 0.5. */
    failureRatio?: number;
    /** Calls in the window before the breaker may open. Default: 20. */
    minRequests?: number;
    /** Rolling window. Default: 10 000. */
    windowMs?: number;
    /** How long it stays open before one probe is let through. Default: 30 000. */
    openTimeoutMs?: number;
  };
}

/** A target with every default applied. */
export interface ResolvedGrpcTarget {
  name: string;
  address: string;
  insecure: boolean;
  timeoutMs: number;
  waitForReady: boolean;
  loadBalancing: string;
  keepalive: { timeMs: number; timeoutMs: number };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    codes: string[];
    methods: string[];
    throttle: { maxTokens: number; tokenRatio: number };
  };
  circuitBreaker: {
    failureRatio: number;
    minRequests: number;
    windowMs: number;
    openTimeoutMs: number;
  };
}

/** gRPC's own cap on attempts (grpc-js clamps silently; here a larger value is rejected). */
const MAX_ATTEMPTS = 5;
/** Below this a server may close the connection for pinging too often (and grpc-go refuses it). */
const MIN_KEEPALIVE_MS = 10_000;
const MAX_THROTTLE_TOKENS = 1000;

/** `target` with the defaults under it. */
export function resolveGrpcTarget(target: GrpcTargetConfig): ResolvedGrpcTarget {
  return {
    name: target.name,
    address: target.address,
    insecure: target.insecure ?? false,
    timeoutMs: target.timeoutMs ?? 5000,
    waitForReady: target.waitForReady ?? false,
    loadBalancing: target.loadBalancing ?? "round_robin",
    keepalive: {
      timeMs: target.keepalive?.timeMs ?? 0,
      timeoutMs: target.keepalive?.timeoutMs ?? 20_000,
    },
    retry: {
      maxAttempts: target.retry?.maxAttempts ?? 3,
      baseDelayMs: target.retry?.baseDelayMs ?? 100,
      maxDelayMs: target.retry?.maxDelayMs ?? 5000,
      codes: target.retry?.codes ?? ["UNAVAILABLE"],
      methods: target.retry?.methods ?? [],
      throttle: {
        maxTokens: target.retry?.throttle?.maxTokens ?? 10,
        tokenRatio: target.retry?.throttle?.tokenRatio ?? 0.1,
      },
    },
    circuitBreaker: {
      failureRatio: target.circuitBreaker?.failureRatio ?? 0.5,
      minRequests: target.circuitBreaker?.minRequests ?? 20,
      windowMs: target.circuitBreaker?.windowMs ?? 10_000,
      openTimeoutMs: target.circuitBreaker?.openTimeoutMs ?? 30_000,
    },
  };
}

/** Does the target retry at all? */
export function retries(target: ResolvedGrpcTarget): boolean {
  return target.retry.maxAttempts > 1;
}

/** `pkg.Service` or `pkg.Service/Method` → its parts; undefined when it is neither. */
export function splitMethod(name: string): { service: string; method?: string } | undefined {
  const match = /^([\w.]+)(?:\/(\w+))?$/u.exec(name);
  if (match?.[1] === undefined) return undefined;
  return match[2] === undefined ? { service: match[1] } : { service: match[1], method: match[2] };
}

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 0;

function problemsOf(target: ResolvedGrpcTarget): string[] {
  const { keepalive, retry, circuitBreaker: breaker } = target;
  const problems: string[] = [];
  const check = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(problem);
  };

  check(target.address !== "", "address is required");
  check(isCount(target.timeoutMs), "timeoutMs must be a whole number ≥ 0");
  check(
    target.loadBalancing === "round_robin" || target.loadBalancing === "pick_first",
    "loadBalancing must be round_robin or pick_first",
  );
  check(
    keepalive.timeMs === 0 || (isCount(keepalive.timeMs) && keepalive.timeMs >= MIN_KEEPALIVE_MS),
    `keepalive.timeMs must be 0 (off) or ≥ ${MIN_KEEPALIVE_MS}`,
  );
  check(
    keepalive.timeMs === 0 || (isCount(keepalive.timeoutMs) && keepalive.timeoutMs > 0),
    "keepalive.timeoutMs must be a whole number > 0",
  );

  check(
    isCount(retry.maxAttempts) && retry.maxAttempts <= MAX_ATTEMPTS,
    `retry.maxAttempts must be a whole number in [0, ${MAX_ATTEMPTS}]`,
  );
  if (retries(target)) {
    check(
      isCount(retry.baseDelayMs) && retry.baseDelayMs > 0,
      "retry.baseDelayMs must be a whole number > 0",
    );
    check(
      isCount(retry.maxDelayMs) && retry.maxDelayMs >= retry.baseDelayMs,
      "retry.maxDelayMs must be a whole number ≥ retry.baseDelayMs",
    );
    check(retry.codes.length > 0, "retry.codes must not be empty");
    for (const code of retry.codes) {
      check(
        code !== "OK" && typeof (status as Record<string, unknown>)[code] === "number",
        `retry.codes: ${JSON.stringify(code)} is not a retryable status name`,
      );
    }
    for (const method of retry.methods) {
      check(
        splitMethod(method) !== undefined,
        `retry.methods: ${JSON.stringify(method)} is not pkg.Service or pkg.Service/Method`,
      );
    }
    check(
      isCount(retry.throttle.maxTokens) && retry.throttle.maxTokens <= MAX_THROTTLE_TOKENS,
      `retry.throttle.maxTokens must be a whole number in [0, ${MAX_THROTTLE_TOKENS}]`,
    );
    check(
      retry.throttle.maxTokens === 0 || retry.throttle.tokenRatio > 0,
      "retry.throttle.tokenRatio must be > 0",
    );
  }

  check(
    breaker.failureRatio >= 0 && breaker.failureRatio < 1,
    "circuitBreaker.failureRatio must be in [0, 1)",
  );
  if (breaker.failureRatio > 0) {
    check(
      isCount(breaker.minRequests) && breaker.minRequests > 0,
      "circuitBreaker.minRequests must be a whole number > 0",
    );
    check(
      isCount(breaker.windowMs) && breaker.windowMs > 0,
      "circuitBreaker.windowMs must be a whole number > 0",
    );
    check(
      isCount(breaker.openTimeoutMs) && breaker.openTimeoutMs > 0,
      "circuitBreaker.openTimeoutMs must be a whole number > 0",
    );
  }
  return problems;
}

/** Every problem of the target list, each prefixed with the target it is about; empty = valid. */
export function grpcTargetProblems(targets: ResolvedGrpcTarget[]): string[] {
  const seen = new Set<string>();
  return targets.flatMap((target, index) => {
    const where = target.name === "" ? `targets[${index}]` : `target ${target.name}`;
    const problems = problemsOf(target);
    if (target.name === "") problems.unshift("name is required");
    else if (seen.has(target.name)) problems.unshift("duplicate name");
    seen.add(target.name);
    return problems.map((problem) => `${where}: ${problem}`);
  });
}
