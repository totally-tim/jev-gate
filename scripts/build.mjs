import { chmodSync } from "node:fs";
import { build } from "esbuild";

// Bundles the action and CLI entrypoints with their dependencies so consumers never run
// an install. `tsc` has already emitted the plain modules and tests into dist/.
const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  sourcemap: false,
  define: { "import.meta.url": "undefined" },
  logLevel: "info",
  // `yaml` and the TypeSafe SDK are bundled intentionally; nothing is external.
};

await build({
  entryPoints: { action: "src/action.ts" },
  outdir: "dist/bundle",
  ...shared,
});

// The CLI installs as a bin (`npm install -g github:<owner>/jev-gate`), so it needs a
// shebang and an executable bit; the action bundle is invoked by the runner and does not.
await build({
  entryPoints: { cli: "src/cli.ts" },
  outdir: "dist/bundle",
  ...shared,
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/bundle/cli.cjs", 0o755);
