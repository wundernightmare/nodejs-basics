import { Readable } from "node:stream";

import type { ResilientClient } from "./resilient-client.js";

/**
 * A fetch over a ResilientClient — the transport for fetch-based clients
 * (the typed @base/contracts client, openapi-fetch in general): every
 * request goes through the client's retries, breaker, limiter, request id
 * and request budget. The URL must be on the client's base URL (it is one
 * target); create the client with `passthrough4xx: true` so 4xx answers reach
 * the caller as responses (a typed client reads their bodies) instead of
 * OutboundErrors.
 */
export function resilientFetch(client: ResilientClient): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    const res = await client.request({
      path: url.pathname + url.search,
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v);
      else if (value !== undefined) responseHeaders.set(key, value);
    }
    const noBody = res.statusCode === 204 || res.statusCode === 304 || request.method === "HEAD";
    return new Response(noBody ? null : (Readable.toWeb(res.body) as ReadableStream), {
      status: res.statusCode,
      headers: responseHeaders,
    });
  };
}
