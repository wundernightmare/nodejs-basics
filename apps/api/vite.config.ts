import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { nodeApp } from "../../vite.app.config.js";

/** Bundle this app to dist/main.js — see vite.app.config.ts at the repo root. */
export default defineConfig(nodeApp(dirname(fileURLToPath(import.meta.url))));
