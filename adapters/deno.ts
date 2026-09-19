/**
 * Deno already speaks the Fetch `(Request) => Response` signature natively
 * at the server boundary -- this adapter is a thin pass-through, not a
 * bridge like the Node one.
 */
import type { CompileResult } from "../src/types.js";

export interface ListenOptions {
  port?: number;
  hostname?: string;
}

export function serve(compiled: CompileResult, options: ListenOptions = {}): void {
  for (const message of compiled.warnings) console.warn(`servable: warning: ${message}`);
  const denoGlobal = (globalThis as { Deno?: { serve: (opts: ListenOptions, handler: (req: Request) => Promise<Response>) => unknown } }).Deno;
  if (!denoGlobal) {
    throw new Error("servable/adapters/deno: Deno global is not present -- this adapter only runs under Deno");
  }
  denoGlobal.serve(options, compiled.fetch);
}
