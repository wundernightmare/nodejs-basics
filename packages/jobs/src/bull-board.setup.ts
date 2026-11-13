import { createBullBoard } from "@bull-board/api";
import { FastifyAdapter as BullBoardFastifyAdapter } from "@bull-board/fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Queue } from "bullmq";

import { Secret } from "@base/common";

const BULL_BOARD_PATH = "/admin/queues";

export interface BullBoardOptions {
  /**
   * The admin token (ADMIN_TOKEN). The board then asks for it on every
   * request: as `Authorization: Bearer <token>`, or — what a browser can do —
   * as the password of HTTP Basic auth, any user name. Unset: no guard, the
   * local default.
   */
  token?: string | Secret | undefined;
}

/**
 * Whether an Authorization header carries the token: `Bearer <token>`, or
 * Basic with the token as the password. An unset token admits everyone.
 */
export function boardAccess(authorization: string | undefined, token: Secret): boolean {
  if (!token.isSet) return true;
  if (authorization === undefined) return false;
  if (authorization.startsWith("Bearer ")) return token.equals(authorization.slice(7));
  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon !== -1 && token.equals(decoded.slice(colon + 1));
  }
  return false;
}

/**
 * Registers BullBoard on /admin/queues, on the listener of `app`.
 *
 * The board retries, promotes and deletes jobs, so on anything but a local
 * stack pass `token`: it shares the API listener, and without the guard
 * access control is left entirely to the ingress / network policy.
 *
 * In local dev: http://localhost:3000/admin/queues/ui
 */
export async function setupBullBoard(
  app: NestFastifyApplication,
  queues: Queue[],
  options: BullBoardOptions = {},
): Promise<void> {
  const token = Secret.of(options.token);
  // @bull-board/api/bullMQAdapter is a CJS module. Use dynamic import() so this
  // file stays valid in both ESM (start:dev / ts-node) and compiled-CJS contexts.
  const { BullMQAdapter } =
    (await import("@bull-board/api/bullMQAdapter")) as typeof import("@bull-board/api/bullMQAdapter");

  const serverAdapter = new BullBoardFastifyAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });

  // @bull-board/fastify types its plugin against the fastify declarations it
  // resolves itself (a second copy under pnpm's isolated layout), so the
  // structurally identical FastifyPluginCallback is a different nominal type
  // from the one NestFastifyApplication.register expects. Type-only cast.
  type Plugin = Parameters<NestFastifyApplication["register"]>[0];
  // tsgolint resolves fastify once and calls the cast unnecessary; tsgo does not.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
  const board = serverAdapter.registerPlugin() as Plugin;

  // A scope of its own, so the guard covers the board and nothing else.
  await app
    .getHttpAdapter()
    .getInstance()
    .register(async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        if (boardAccess(request.headers.authorization, token)) return;
        await reply
          .code(401)
          .header("WWW-Authenticate", 'Basic realm="queues", charset="UTF-8"')
          .send({ status: 401, title: "Unauthorized" });
      });
      await scope.register(board, { prefix: BULL_BOARD_PATH });
    });
}
