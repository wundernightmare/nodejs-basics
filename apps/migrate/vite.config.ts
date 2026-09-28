import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { nodeApp } from "../../vite.app.config.js";

/** One self-contained dist/main.js (pg included) — the image ships no node_modules. */
export default defineConfig(
  nodeApp(dirname(fileURLToPath(import.meta.url)), { selfContained: true }),
);
