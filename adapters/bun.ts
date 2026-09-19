/**
 * Bun already speaks the Fetch `(Request) => Response` signature natively
 * at the server boundary -- this adapter is a thin pass-through, not a
 * bridge like the Node one.
 */
import type { CompileResult } from "../src/types.js";

export interface ListenOptions {
  port?: number;
  hostname?: string;
}

export function serve(compiled: CompileResult, options: ListenOptions = {}): unknown {
  for (const message of compiled.warnings) console.warn(`servable: warning: ${message}`);
  const bunGlobal = (globalThis as { Bun?: { serve: (opts: ListenOptions & { fetch: (req: Request) => Promise<Response> }) => unknown } }).Bun;
  if (!bunGlobal) {
    throw new Error("servable/adapters/bun: Bun global is not present -- this adapter only runs under Bun");
  }
  return bunGlobal.serve({ ...options, fetch: compiled.fetch });
}
