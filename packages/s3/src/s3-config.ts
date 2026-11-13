import { Secret } from "@base/common";

/**
 * Object-storage configuration. Built by hand, or from the environment with a
 * per-service prefix (`s3ConfigFromEnv(process.env, "INGEST_")`); the same
 * keys and defaults as golang-basics' libs/s3.
 *
 * There is no default bucket, so a service can treat object storage as
 * optional — on when S3_BUCKET is set (see {@link s3Configured}).
 *
 *   S3_BUCKET              bucket every call addresses                     (default "": off)
 *   S3_ENDPOINT            base URL of an S3-compatible store; "" = AWS    (default "")
 *   S3_REGION              signing region                                  (default "us-east-1")
 *   S3_ACCESS_KEY_ID       static credentials; "" = the AWS default chain  (default "")
 *   S3_SECRET_ACCESS_KEY   …                                               (default "")
 *   S3_USE_PATH_STYLE      endpoint/bucket/key instead of bucket.endpoint  (default true)
 *   S3_INSECURE            allow an http:// endpoint                       (default false)
 *   S3_CA_FILE             PEM bundle that signs the endpoint's cert       (default "": system roots)
 *   S3_AUTO_CREATE_BUCKET  create the bucket in ensure() when missing      (default false)
 *
 * Deadlines and retries — every call carries its own deadline:
 *
 *   S3_DIAL_TIMEOUT_MS      TCP + TLS connect                               (default 5000)
 *   S3_OP_TIMEOUT_MS        one put/head/list page/delete, retries included (default 10000)
 *   S3_TRANSFER_TIMEOUT_MS  one get (body included) or one multipart part   (default 60000)
 *   S3_MAX_ATTEMPTS         tries per call inside its deadline (1 = none)   (default 3)
 *
 * Memory and connections — bounded by named keys, never a client default:
 *
 *   S3_MAX_CONNS_PER_HOST   connections to the endpoint                     (default 32)
 *   S3_UPLOAD_PART_BYTES    buffer of one multipart part (min 5 MiB)        (default 16777216)
 *
 * Compatibility:
 *
 *   S3_REQUEST_CHECKSUM     when_required | when_supported                  (default when_required)
 *
 * when_supported is the SDK's own default (a CRC32 trailer on every upload);
 * several S3-compatible stores reject it, so the default here is the
 * conservative one.
 */
export interface S3Config {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: Secret;
  usePathStyle: boolean;
  insecure: boolean;
  caFile: string;
  autoCreateBucket: boolean;
  dialTimeoutMs: number;
  opTimeoutMs: number;
  transferTimeoutMs: number;
  maxAttempts: number;
  maxConnsPerHost: number;
  uploadPartBytes: number;
  requestChecksum: "when_required" | "when_supported";
}

export const MIN_PART_BYTES = 5 * 1024 * 1024;

export const S3_DEFAULTS: S3Config = {
  bucket: "",
  endpoint: "",
  region: "us-east-1",
  accessKeyId: "",
  secretAccessKey: Secret.unset,
  usePathStyle: true,
  insecure: false,
  caFile: "",
  autoCreateBucket: false,
  dialTimeoutMs: 5_000,
  opTimeoutMs: 10_000,
  transferTimeoutMs: 60_000,
  maxAttempts: 3,
  maxConnsPerHost: 32,
  uploadPartBytes: 16 * 1024 * 1024,
  requestChecksum: "when_required",
};

/** Whether a bucket is set: the switch for a service that can run without object storage. */
export function s3Configured(config: Pick<S3Config, "bucket">): boolean {
  return config.bucket !== "";
}

function bool(raw: string | undefined, fallback: boolean, key: string): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`s3: ${key} must be true or false, got ${JSON.stringify(raw)}`);
}

function int(raw: string | undefined, fallback: number, key: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value))
    throw new Error(`s3: ${key} must be an integer, got ${JSON.stringify(raw)}`);
  return value;
}

/** Reads `<prefix>S3_*` from `env` and validates the result. */
export function s3ConfigFromEnv(env: Record<string, string | undefined>, prefix = ""): S3Config {
  const key = (name: string): string => `${prefix}S3_${name}`;
  const text = (name: string, fallback: string): string => {
    const raw = env[key(name)];
    return raw === undefined || raw === "" ? fallback : raw;
  };
  const d = S3_DEFAULTS;
  return validateS3Config({
    bucket: text("BUCKET", d.bucket),
    endpoint: text("ENDPOINT", d.endpoint),
    region: text("REGION", d.region),
    accessKeyId: text("ACCESS_KEY_ID", d.accessKeyId),
    secretAccessKey: Secret.of(env[key("SECRET_ACCESS_KEY")]),
    usePathStyle: bool(env[key("USE_PATH_STYLE")], d.usePathStyle, key("USE_PATH_STYLE")),
    insecure: bool(env[key("INSECURE")], d.insecure, key("INSECURE")),
    caFile: text("CA_FILE", d.caFile),
    autoCreateBucket: bool(
      env[key("AUTO_CREATE_BUCKET")],
      d.autoCreateBucket,
      key("AUTO_CREATE_BUCKET"),
    ),
    dialTimeoutMs: int(env[key("DIAL_TIMEOUT_MS")], d.dialTimeoutMs, key("DIAL_TIMEOUT_MS")),
    opTimeoutMs: int(env[key("OP_TIMEOUT_MS")], d.opTimeoutMs, key("OP_TIMEOUT_MS")),
    transferTimeoutMs: int(
      env[key("TRANSFER_TIMEOUT_MS")],
      d.transferTimeoutMs,
      key("TRANSFER_TIMEOUT_MS"),
    ),
    maxAttempts: int(env[key("MAX_ATTEMPTS")], d.maxAttempts, key("MAX_ATTEMPTS")),
    maxConnsPerHost: int(
      env[key("MAX_CONNS_PER_HOST")],
      d.maxConnsPerHost,
      key("MAX_CONNS_PER_HOST"),
    ),
    uploadPartBytes: int(
      env[key("UPLOAD_PART_BYTES")],
      d.uploadPartBytes,
      key("UPLOAD_PART_BYTES"),
    ),
    requestChecksum: text("REQUEST_CHECKSUM", d.requestChecksum) as S3Config["requestChecksum"],
  });
}

/**
 * Fills the defaults and rejects a config the client could not run with —
 * every problem at once, so a deploy is fixed in one round.
 */
export function validateS3Config(partial: Partial<S3Config>): S3Config {
  const config: S3Config = { ...S3_DEFAULTS, ...partial };
  const problems: string[] = [];

  for (const field of [
    "dialTimeoutMs",
    "opTimeoutMs",
    "transferTimeoutMs",
    "maxAttempts",
    "maxConnsPerHost",
  ] as const) {
    if (!(config[field] >= 1)) problems.push(`${field} must be at least 1`);
  }
  if (!(config.uploadPartBytes >= MIN_PART_BYTES)) {
    problems.push(`uploadPartBytes must be at least ${MIN_PART_BYTES} (the S3 minimum part size)`);
  }
  if (config.requestChecksum !== "when_required" && config.requestChecksum !== "when_supported") {
    problems.push("requestChecksum must be when_required or when_supported");
  }
  if ((config.accessKeyId === "") !== !config.secretAccessKey.isSet) {
    problems.push("accessKeyId and secretAccessKey must be set together");
  }
  if (config.endpoint !== "") {
    let url: URL | undefined;
    try {
      url = new URL(config.endpoint);
    } catch {
      problems.push("endpoint must be a URL");
    }
    if (url !== undefined) {
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        problems.push("endpoint must be http(s)");
      } else if (url.protocol === "http:" && !config.insecure) {
        problems.push("endpoint is http:// — set insecure to allow it");
      }
      if (url.username !== "" || url.password !== "") {
        problems.push("endpoint must not carry credentials");
      }
    }
  }
  if (problems.length > 0) throw new Error(`s3: invalid config: ${problems.join("; ")}`);
  return config;
}
