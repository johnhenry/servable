/**
 * Cloudflare Workers already speaks the Fetch `(Request) => Response`
 * signature natively (that's the whole `export default { fetch }` Workers
 * contract) -- this adapter just hands the compiled dispatcher back in that
 * exact shape.
 */
import type { CompileResult } from "../src/types.js";

export function toWorker(compiled: CompileResult): { fetch: (req: Request) => Promise<Response> } {
  for (const message of compiled.warnings) console.warn(`servable: warning: ${message}`);
  return { fetch: compiled.fetch };
}
