import { stat } from "node:fs/promises";

/** True if `p` exists on disk (file or directory). Uses `stat` so directories are detected reliably. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
