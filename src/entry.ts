import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Compare two paths, following symlinks when they exist. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return pathToFileURL(a).href === pathToFileURL(b).href;
  }
}

/**
 * True when this module is the process entrypoint. Works both for the ESM that `tsc`
 * emits and for the bundled CJS that GitHub Actions runs, where `import.meta` is empty.
 * An installed bin is a symlink and Node resolves the real path of the main module, so
 * the comparison follows symlinks on both sides.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const moduleFile =
    typeof __filename === "string" ? __filename : fileURLToPath(moduleUrl);
  return samePath(entry, moduleFile);
}
