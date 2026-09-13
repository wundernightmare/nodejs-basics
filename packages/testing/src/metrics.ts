/**
 * Read one sample out of a Prometheus text exposition (what `/metrics`
 * serves). Returns -1 when the series is absent — the Go sibling's
 * `testx.Metric` convention — so a test can distinguish "zero" from "not
 * exported". `labels` must all match; extra labels on the sample are fine.
 *
 *   metricValue(text, "http_server_request_duration_milliseconds_count", { http_route: "/tasks" })
 */
export function metricValue(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number {
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const rest = line.slice(name.length);
    const m = /^(\{([^}]*)\})?\s+(\S+)/u.exec(rest);
    if (!m) continue;
    const have = parseLabels(m[2] ?? "");
    if (Object.entries(labels).every(([k, v]) => have[k] === v)) return Number(m[3]);
  }
  return -1;
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)="((?:\\.|[^"\\])*)"/gu)) {
    out[m[1] as string] = (m[2] as string).replace(/\\(.)/gu, "$1");
  }
  return out;
}
