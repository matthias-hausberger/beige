/**
 * Log file rotation utilities.
 *
 * Two rotation strategies are used in beige:
 *
 * - gateway.log  → rotate-on-startup (called once when the gateway process
 *                  starts).  In daemon mode stdout/stderr are redirected to an
 *                  open file descriptor, so mid-run rotation would require
 *                  reopening the fd — the standard Unix logrotate/SIGHUP
 *                  problem.  Rotating at startup keeps things simple and
 *                  correct: every gateway run gets a fresh log file and the
 *                  previous run's log is immediately archived.
 *
 * - audit.jsonl  → size-based rotation at write time (checked before every
 *                  append in AuditLogger).  Audit entries are written via
 *                  appendFileSync, so the file can be safely renamed and a
 *                  new one started without touching any open fd.
 *
 * Rotation scheme (same for both):
 *   gateway.log        ← current (always the live file)
 *   gateway.log.1      ← most recent archive
 *   gateway.log.2
 *   …
 *   gateway.log.N      ← oldest archive (deleted when the limit is reached)
 *
 * Defaults (also used when config is absent):
 *   maxSizeBytes = 10 MB  (10 × 1024 × 1024)
 *   maxFiles     = 5
 */

import { existsSync, statSync, renameSync, unlinkSync } from "fs";

export const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_FILES = 5;

/**
 * Rename `filePath` → `filePath.1`, shifting older archives up by one.
 * The oldest archive beyond `maxFiles` is deleted.
 *
 * No-op when `filePath` does not exist.
 */
export function rotateFile(filePath: string, maxFiles: number = DEFAULT_MAX_FILES): void {
  if (!existsSync(filePath)) return;

  try {
    // Delete the oldest archive if it would exceed the retention limit.
    const oldest = `${filePath}.${maxFiles}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }

    // Shift existing archives: .4 → .5, .3 → .4, …, .1 → .2
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (existsSync(src)) {
        renameSync(src, dst);
      }
    }

    // Rename the live file to .1
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // Rotation is best-effort — a failure here must never crash the gateway.
  }
}

/**
 * Rotate `filePath` only when it currently exceeds `maxSizeBytes`.
 * Used for write-time rotation (audit.jsonl).
 */
export function rotateFileIfNeeded(
  filePath: string,
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES,
  maxFiles: number = DEFAULT_MAX_FILES
): void {
  try {
    if (!existsSync(filePath)) return;
    if (statSync(filePath).size < maxSizeBytes) return;
  } catch {
    return; // Can't stat — leave the file alone
  }
  rotateFile(filePath, maxFiles);
}
