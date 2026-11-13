import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";

import { Secret } from "@base/common";
import { testCase } from "@base/testing";

import { boardAccess, setupBullBoard } from "./bull-board.setup.js";

const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("boardAccess", () => {
  const token = Secret.of("board-token");

  it("admits the token as a bearer or as the Basic password", async () => {
    await testCase("NB-1202", "Bull Board: the admin token guards every request");
    expect(boardAccess("Bearer board-token", token)).toBe(true);
    expect(boardAccess(basic("admin", "board-token"), token)).toBe(true);
    expect(boardAccess(basic("", "board-token"), token)).toBe(true);
  });

  it("rejects everything else", async () => {
    await testCase("NB-1202", "Bull Board: the admin token guards every request");
    for (const header of [
      undefined,
      "",
      "Bearer ",
      "Bearer wrong",
      "bearer board-token",
      basic("board-token", "wrong"),
      basic("admin", ""),
      "Basic !!!",
      `Basic ${Buffer.from("no-colon").toString("base64")}`,
      "board-token",
    ]) {
      expect(boardAccess(header, token)).toBe(false);
    }
  });

  it("admits everyone when no token is configured", async () => {
    await testCase("NB-1203", "Bull Board: no token means no guard (local default)");
    expect(boardAccess(undefined, Secret.unset)).toBe(true);
    expect(boardAccess("Bearer anything", Secret.of(""))).toBe(true);
  });
});

/** What the tests use of the Fastify instance behind the adapter. */
interface Server {
  get(path: string, handler: () => unknown): unknown;
  ready(): PromiseLike<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: "GET";
    url: string;
    headers?: Record<string, string>;
  }): Promise<{ statusCode: number; headers: Record<string, unknown> }>;
}

/** The part of a Nest application the setup uses, over a real Fastify instance. */
async function board(token?: string): Promise<Server> {
  const adapter = new FastifyAdapter();
  const fastify = adapter.getInstance() as Server;
  fastify.get("/tasks", () => ({ ok: true }));
  const app = { getHttpAdapter: () => adapter } as unknown as NestFastifyApplication;
  await setupBullBoard(app, [], token === undefined ? {} : { token });
  await fastify.ready();
  return fastify;
}

describe("setupBullBoard", () => {
  it("answers 401 with a Basic challenge until the token is presented", async () => {
    await testCase("NB-1202", "Bull Board: the admin token guards every request");
    const fastify = await board("board-token");
    try {
      const refused = await fastify.inject({ method: "GET", url: "/admin/queues/api/queues" });
      expect(refused.statusCode).toBe(401);
      expect(refused.headers["www-authenticate"]).toContain("Basic");

      for (const authorization of ["Bearer board-token", basic("ops", "board-token")]) {
        const admitted = await fastify.inject({
          method: "GET",
          url: "/admin/queues/api/queues",
          headers: { authorization },
        });
        expect(admitted.statusCode).toBe(200);
      }
      // The guard covers the board and nothing else.
      expect((await fastify.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });

  it("is open without a token", async () => {
    await testCase("NB-1203", "Bull Board: no token means no guard (local default)");
    const fastify = await board();
    try {
      const open = await fastify.inject({ method: "GET", url: "/admin/queues/api/queues" });
      expect(open.statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });
});
