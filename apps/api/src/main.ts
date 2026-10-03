// Telemetry MUST be the first import — instrumentation hooks register here
// before NestJS or any user code is loaded.
import "./instrumentation.js";

import { processEnv, readInt } from "@base/config";
import { AppLogger, pinoLogger } from "@base/logger";

import { createApp } from "./app.js";

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = readInt(processEnv, "PORT");
  await app.listen(port, "0.0.0.0");
  app.get(AppLogger).log(`Listening on http://0.0.0.0:${port}`, "Bootstrap");
}

bootstrap().catch((err) => {
  pinoLogger.fatal({ err }, "Bootstrap failed");
  process.exit(1);
});
