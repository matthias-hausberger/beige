/**
 * Beige runtime path resolution.
 *
 * All runtime data (config, sessions, sockets, logs, etc.) lives under a
 * single "beige home" directory.  The location is resolved in priority order:
 *
 *   1. BEIGE_HOME env var  — set this to redirect everything to a custom dir.
 *      `pnpm run beige` sets BEIGE_HOME=./.beige so that source-checkout runs
 *      are fully self-contained inside the repo and never touch the global
 *      ~/.beige used by the npm-global install.
 *
 *   2. ~/.beige             — the default for npm-global installs.
 *
 * Every module that needs a runtime path should import `beigeDir` from here
 * rather than calling `resolve(homedir(), ".beige")` directly.
 */

import { resolve } from "path";
import { homedir } from "os";

/**
 * Returns the absolute path to the beige home directory.
 * Respects the BEIGE_HOME environment variable.
 */
export function beigeDir(): string {
  const env = process.env.BEIGE_HOME;
  if (env) {
    return resolve(env);
  }
  return resolve(homedir(), ".beige");
}
