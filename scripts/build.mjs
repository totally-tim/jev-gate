import { build } from "esbuild";

// Bundles the action and CLI entrypoints with their dependencies so consumers never run
// an install. `tsc` has already emitted the plain modules and tests into dist/.
await build({
  entryPoints: {
    action: "src/action.ts",
    cli: "src/cli.ts",
  },
  outdir: "dist/bundle",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  sourcemap: false,
  logLevel: "info",
  // `yaml` and the TypeSafe SDK are bundled intentionally; nothing is external.
});
