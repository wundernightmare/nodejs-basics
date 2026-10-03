import type { ServerResponse } from "node:http";

import { type ArgumentsHost, BadRequestException, HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { HttpExceptionFilter } from "./http-exception.filter.js";

/** An ArgumentsHost over a bare Node response — the middleware path (no FastifyReply). */
function nodeHost(): {
  host: ArgumentsHost;
  res: ServerResponse;
  sent: () => Record<string, unknown>;
} {
  let body = "";
  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: (chunk: string) => {
      body = chunk;
    },
  } as unknown as ServerResponse;
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: "/x" }) }),
  } as unknown as ArgumentsHost;
  return { host, res, sent: () => JSON.parse(body) as Record<string, unknown> };
}

describe("HttpExceptionFilter", () => {
  meta({ epic: "nodejs-basics", feature: "errors", owner: "@team-platform", tags: ["unit"] });

  it("answers a bare Node response with problem+json, detail from any body shape", async () => {
    await testCase("NB-1009", "string, string[] and { message } bodies all become `detail`");
    const filter = new HttpExceptionFilter();
    const cases: Array<[HttpException, string]> = [
      [new HttpException("plain text", 409), "plain text"],
      [new BadRequestException(["a is required", "b is too long"]), "a is required; b is too long"],
      [new BadRequestException("one message"), "one message"],
    ];
    for (const [exception, detail] of cases) {
      const { host, res, sent } = nodeHost();
      filter.catch(exception, host);
      expect(res.statusCode).toBe(exception.getStatus());
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/problem+json");
      expect(sent()).toMatchObject({ status: exception.getStatus(), detail, instance: "/x" });
    }
  });

  it("logs a 5xx with its error id, not a 4xx", async () => {
    await testCase("NB-1010", "a server error is logged once, with the id the client sees");
    const error = vi.fn();
    const filter = new HttpExceptionFilter({ logger: { warn: vi.fn(), error } });
    filter.catch(new BadRequestException("no"), nodeHost().host);
    expect(error).not.toHaveBeenCalled();

    const { host, sent } = nodeHost();
    filter.catch(new HttpException("boom", 503), host);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatchObject({ "error.id": sent()["errorId"] });
  });
});
