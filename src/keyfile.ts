import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Writes an SSH private key to a file only its owner can read, because `ssh`
 * insists on a file path. The directory is private too. Call `dispose` when done.
 */
export const withKeyFile = (key: string): { path: string; dispose: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "vm-gh-runners-key-"));
  const path = join(dir, "id");
  // ssh rejects a key file that does not end in a newline.
  writeFileSync(path, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};
