import { builtinModules } from "node:module";
import * as path from "node:path";

import swc from "unplugin-swc";
import type { Plugin, UserConfig } from "vite";

/**
 * The Vite build every app shares (`apps/<app>/vite.config.ts` calls this).
 *
 * One bundle per app — `dist/main.js` (ESM, Node 24, source map):
 *
 * - `@base/*` workspace packages are bundled from their `src/` (the `source`
 *   export condition, the same one vitest and `start:dev` use), so an app
 *   build needs no prior package build and the watch mode (`pnpm dev`)
 *   rebuilds on a change anywhere in the workspace. Every other bare import
 *   (node_modules, node: builtins) stays external and is resolved at runtime
 *   — native addons (@confluentinc/kafka-javascript) and OpenTelemetry's
 *   module patching both need the real modules on disk.
 * - NestJS needs TypeScript's legacy decorators with `emitDecoratorMetadata`
 *   (constructor injection reads `design:paramtypes`). Vite's own TS
 *   transform (oxc) does not emit metadata, so the transform is SWC
 *   (unplugin-swc), mirroring tsconfig.base.json: legacy decorators, metadata,
 *   `useDefineForClassFields: false`.
 * - Not minified: stack traces and the source map stay readable, and the
 *   image scanners see the same code the repo has.
 */
const isBare = (id: string): boolean =>
  !id.startsWith(".") && !path.isAbsolute(id) && !id.startsWith("\0");
const isBuiltin = (id: string): boolean => id.startsWith("node:") || builtinModules.includes(id);

/**
 * External imports made *from a bundled workspace package* are resolved from
 * that package's own node_modules and emitted as file paths. Bundling
 * `packages/observability/src` into `apps/api/dist/main.js` moves its
 * `import "@opentelemetry/api"` into the app — where pnpm's strict layout does
 * not provide it (it is observability's dependency, not the app's). Resolving
 * at build time keeps every package's dependency list honest: the app declares
 * only what it imports itself, the packages what they import.
 */
function workspaceExternals(root: string): Plugin {
  const pkgs = path.join(root, "packages") + path.sep;
  return {
    name: "workspace-externals",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !isBare(source) || isBuiltin(source) || source.startsWith("@base/"))
        return null;
      if (!importer.startsWith(pkgs)) return null; // the app's own imports stay bare
      const r = await this.resolve(source, importer, { skipSelf: true });
      return r ? { id: r.id, external: true } : null;
    },
  };
}

export function nodeApp(appDir: string): UserConfig {
  const root = path.resolve(appDir, "..", "..");
  const pkgs = path.join(root, "packages") + path.sep;
  return {
    // Resolve the way Node will at runtime — exports conditions node / import /
    // default (plus `source` for the workspace packages) and the `main` field,
    // never the bundler-only `module` condition / field (it points at ESM
    // builds with extension-less imports Node cannot load, e.g. @aws-sdk's
    // dist-es). This keeps the paths workspaceExternals emits identical to
    // what a bare import of the same package resolves to: one module instance.
    resolve: { conditions: ["source", "node", "import", "default"], mainFields: ["main"] },
    ssr: {
      target: "node",
      // Vite's own SSR externalisation would answer for bare imports before
      // workspaceExternals gets to see them; switch it off and decide below.
      noExternal: true,
      resolve: { conditions: ["source", "node", "import", "default"], mainFields: ["main"] },
    },
    plugins: [
      workspaceExternals(root),
      swc.vite({
        tsconfigFile: false,
        jsc: {
          target: "es2023",
          parser: { syntax: "typescript", decorators: true },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
            useDefineForClassFields: false,
          },
        },
      }),
    ],
    build: {
      ssr: path.resolve(appDir, "src/main.ts"),
      target: "node24",
      outDir: path.resolve(appDir, "dist"),
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      rollupOptions: {
        // The app's own bare imports (node_modules, node: builtins) stay
        // external and bare; only `@base/*` is bundled (from src, `source`
        // condition). Imports the bundled packages make are handled by
        // workspaceExternals above.
        external: (id, importer) =>
          isBuiltin(id) ||
          (isBare(id) && !id.startsWith("@base/") && !(importer?.startsWith(pkgs) ?? false)),
        // Emit those resolved paths relative to dist/, so the bundle is tied to
        // the workspace tree it was built in, not to its absolute location.
        makeAbsoluteExternalsRelative: true,
        output: { entryFileNames: "main.js", format: "es", inlineDynamicImports: true },
      },
    },
  };
}
