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
import { tracingChannel } from "node:diagnostics_channel";
import type { Server } from "node:net";
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
  /**
   * Receives the server's `'error'` events -- a failed `listen()`
   * (`EADDRINUSE`, `EACCES`, a bad host) above all. Without it, such an
   * error is an uncaught exception, as with leserve itself.
   */
  onError?: (error: NodeJS.ErrnoException) => void;
}

/** What `serve()` returns: leserve's handle plus the underlying server. */
export type ServeHandle = ReturnType<typeof serveLeserve> & {
  /**
   * The `http.Server`/`https.Server` leserve created, for
   * `closeAllConnections()` after a drain timeout and the like. Undefined
   * only if it couldn't be identified (not expected on Node >= 26).
   */
  readonly server: (Server & { closeAllConnections?: () => void; closeIdleConnections?: () => void }) | undefined;
};

// leserve 0.1's serve() neither returns its server nor listens for its
// 'error' event. Node publishes every net.Server.listen() call on this
// tracing channel synchronously, inside listen(), before any error can be
// emitted -- and leserve calls listen() synchronously inside serve() -- so
// subscribing for exactly the duration of that call identifies leserve's
// server and lets an error listener be attached in time.
const listenChannel = tracingChannel<object, { server: Server }>("net.server.listen");

/** Wraps a compiled dispatcher into a real `node:http` server. */
export function serve(compiled: CompileResult, options: ListenOptions = {}): ServeHandle {
  for (const message of compiled.warnings) console.warn(`servable: warning: ${message}`);
  let server: Server | undefined;
  const capture = {
    asyncStart(message: { server: Server }) {
      if (server) return;
      server = message.server;
      if (options.onError) server.on("error", options.onError);
    },
  };
  listenChannel.subscribe(capture as never);
  let handle: ReturnType<typeof serveLeserve>;
  try {
    handle = startLeserve(compiled, options);
  } finally {
    listenChannel.unsubscribe(capture as never);
  }
  return Object.assign(handle, { server }) as ServeHandle;
}

function startLeserve(compiled: CompileResult, options: ListenOptions): ReturnType<typeof serveLeserve> {
  const { onError: _onError, ...leserveOptions } = options;
  return serveLeserve(async (request: Request) => {
    const response = await compiled.fetch(request);
    // Bridges compile.ts's own (runtime-agnostic) pendingTrailers WeakMap
    // to leserve's -- servable's core doesn't know leserve exists (it has
    // to stay portable across Deno/Bun/Workers), so this is the one place
    // that connects the two.
    const trailers = pendingTrailers.get(response);
    if (trailers) setTrailers(response, trailers);
    return response;
  }, leserveOptions);
}
