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

  await app.register(serverAdapter.registerPlugin(), { prefix: BULL_BOARD_PATH });
}
