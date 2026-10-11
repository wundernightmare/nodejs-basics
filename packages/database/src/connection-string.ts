/**
 * Merge libpq query parameters (target_session_attrs, sslmode, connect
 * timeout, application_name) into the connection string.
 *
 * Env keys win over URL-embedded values so a ConfigMap-rendered URL can
 * be overridden by a Secret-mounted knob without re-templating. Skips
 * params the caller didn't set — the original URL stays untouched
 * otherwise.
 *
 * WHATWG `new URL()` rejects libpq multi-host URIs (`h1:5432,h2:5432`
 * isn't a valid hostname in that spec), so we split on the first `?`
 * ourselves: everything before stays verbatim (preserves the CSV host
 * list libpq understands), everything after is reparsed as
 * URLSearchParams where `set` replaces any existing key. Lets pg-native
 * see the primary-selection knobs on every host.
 *
 * A module of its own (`@base/database/connection-string`): the migrate app
 * bundles it without Nest, the pool or the resilience builders.
 */
export function decorateConnectionString(
  rawUrl: string,
  params: Record<string, string | undefined>,
): string {
  const providedEntries = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (providedEntries.length === 0) return rawUrl;

  // A libpq "key=value" connection string (no URI scheme) has no place
  // to stuff extra query params — libpq reads space-separated pairs.
  // Only URI-shaped strings accept our decoration; return everything
  // else untouched and let libpq parse it as-is.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(rawUrl)) return rawUrl;

  const queryIdx = rawUrl.indexOf("?");
  const [beforeQuery, query] =
    queryIdx === -1 ? [rawUrl, ""] : [rawUrl.slice(0, queryIdx), rawUrl.slice(queryIdx + 1)];

  const qp = new URLSearchParams(query);
  for (const [k, v] of providedEntries) {
    qp.set(k, v);
  }
  const merged = qp.toString();
  return merged.length > 0 ? `${beforeQuery}?${merged}` : beforeQuery;
}
