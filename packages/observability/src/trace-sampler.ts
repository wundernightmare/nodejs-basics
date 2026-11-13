import {
  ParentBasedSampler,
  type Sampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

/**
 * The sampler for OTEL_TRACES_SAMPLER_RATIO: the caller's decision when the
 * request arrives inside a trace (so a trace is whole or absent, never half),
 * the ratio for the traces this service starts. Unset or not a number in
 * 0..1 is 1 — everything; the config check reports the bad value at boot.
 * The same rule as golang-basics' otelx.
 */
export function traceSampler(raw: string | undefined): Sampler {
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(samplerRatio(raw)) });
}

export function samplerRatio(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const ratio = Number(raw);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1;
}
