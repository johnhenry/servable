/**
 * Node adapter. `node:http` speaks `IncomingMessage`/`ServerResponse`, not
 * `Request`/`Response` -- rather than maintaining a second, independently-
 * drifting bridge for that conversion, this delegates to `leserve`'s
 * `serve()`, which already solves it (correctly handling multi-value
 * headers like repeated `Set-Cookie`, forwarding stream errors via
 * `stream/promises`'s `pipeline()` instead of a bare `.pipe()`, and the
 * malformed-request-target edge case) -- the same "prefer an existing,
 * more mature implementation over reinventing it" discipline this whole
 * design leaned on for `Request`/`Response`/`Headers`/`URLPattern`.
 *
 * This is also what makes `upgradeWebSocket()`'s Node branch (api.ts) work
 * at all: `leserve`'s `serve()` always attaches the raw `IncomingMessage`
 * to the `Request` it constructs (`req.raw`), which is exactly what
 * `leserve`'s `upgradeRawSocket()` needs.
 */
import serveLeserve from "@johnhenry/leserve";
import { setTrailers } from "@johnhenry/leserve/trailers";
import { pendingTrailers } from "../src/compile.js";
import type { CompileResult } from "../src/types.js";

export interface ListenOptions {
  port?: number;
  hostname?: string;
  cert?: string;
  key?: string;
  signal?: AbortSignal;
  /** Called once the server is actually listening -- necessary for `port: 0` (an OS-assigned ephemeral port), since the real port isn't known until then. */
  onListen?: (info: { path: string; port: number }) => void;
}

/** Wraps a compiled dispatcher into a real `node:http` server. */
export function serve(compiled: CompileResult, options: ListenOptions = {}): ReturnType<typeof serveLeserve> {
  for (const message of compiled.warnings) console.warn(`servable: warning: ${message}`);
  return serveLeserve(async (request: Request) => {
    const response = await compiled.fetch(request);
    // Bridges compile.ts's own (runtime-agnostic) pendingTrailers WeakMap
    // to leserve's -- servable's core doesn't know leserve exists (it has
    // to stay portable across Deno/Bun/Workers), so this is the one place
    // that connects the two.
    const trailers = pendingTrailers.get(response);
    if (trailers) setTrailers(response, trailers);
    return response;
  }, options);
}
