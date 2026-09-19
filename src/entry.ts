import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * True when this module is the process entrypoint. Works both for the ESM that `tsc`
 * emits and for the bundled CJS that GitHub Actions runs, where `import.meta` is empty.
 */
export function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const moduleFile = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  return pathToFileURL(entry).href === pathToFileURL(moduleFile).href;
}
