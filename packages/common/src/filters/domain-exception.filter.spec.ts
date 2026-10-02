import { type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { DomainError } from "../errors/domain-error.base.js";

import { createDomainExceptionFilter } from "./domain-exception.filter.js";

class BusyError extends DomainError {
  readonly _tag = "BusyError" as const;
  constructor(override readonly retryAfterSeconds?: number) {
    super("try later");
  }
}

function host(): { host: ArgumentsHost; headers: Record<string, string>; status: () => number } {
  const headers: Record<string, string> = {};
  let status = 0;
  const reply = {
    status(code: number) {
      status = code;
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send: () => reply,
  };
  const ctx = {
    getResponse: () => reply,
    getRequest: () => ({ url: "/x", routeOptions: { url: "/x" } }),
  };
  return {
    host: { switchToHttp: () => ctx } as unknown as ArgumentsHost,
    headers,
    status: () => status,
  };
}

describe("DomainExceptionFilter", () => {
  meta({ epic: "nodejs-basics", feature: "errors", owner: "@team-platform", tags: ["common"] });

  it("sends Retry-After for a 429/503 domain error that carries retryAfterSeconds", async () => {
    await testCase("NB-911", "retryable domain errors tell the client when to retry");
    const filter = createDomainExceptionFilter({ BusyError: { status: 503 } }, [BusyError]);
    const h = host();
    filter.catch(new BusyError(1.2), h.host);
    expect(h.status()).toBe(503);
    expect(h.headers["Retry-After"]).toBe("2");

    const none = host();
    filter.catch(new BusyError(), none.host);
    expect(none.headers["Retry-After"]).toBeUndefined();
  });

  it("does not send Retry-After for other statuses", async () => {
    await testCase("NB-912", "Retry-After only on 429/503");
    const filter = createDomainExceptionFilter({ BusyError: { status: 409 } }, [BusyError]);
    const h = host();
    filter.catch(new BusyError(5), h.host);
    expect(h.headers["Retry-After"]).toBeUndefined();
  });
});
