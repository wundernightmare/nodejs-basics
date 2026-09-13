import { createBullBoard } from "@bull-board/api";
import { FastifyAdapter as BullBoardFastifyAdapter } from "@bull-board/fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Queue } from "bullmq";

const BULL_BOARD_PATH = "/admin/queues";

/**
 * Registers BullBoard on /admin/queues.
 *
 * The route is intentionally unprotected at the application layer —
 * access control must be enforced via Kubernetes ingress annotations
 * or an internal network policy (not publicly reachable in production).
 *
 * In local dev: http://localhost:3000/admin/queues/ui
 */
export async function setupBullBoard(app: NestFastifyApplication, queues: Queue[]): Promise<void> {
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
  await app.register(serverAdapter.registerPlugin() as Plugin, { prefix: BULL_BOARD_PATH });
}
