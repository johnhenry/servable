/**
 * Runtime API: linkTo(), warn(), markdownToHtml(), setCookie(), sse(),
 * streamBody(), upgradeWebSocket(), serveFile(). Direct analogues of
 * fileable's own api.ts (linkTo/warn/markdownToHtml reuse the exact same
 * ideas, applied to routes instead of files).
 */
import { marked } from "marked";
import { recordWarning } from "./context.js";
import { linkRegistry } from "./link-registry.js";
import { ServableError } from "./types.js";
import type { Descriptor } from "./types.js";

export { serveFile } from "./serve-file.js";
export type { ServeFileOptions } from "./serve-file.js";

/**
 * Two callers, two timings -- see link-registry.ts's own doc comment for
 * the full explanation. Called while a tree is being authored (embedded in
 * static markup children): the registry is empty/stale for a tree that
 * hasn't been compiled yet, so this returns a LinkRef marker for Layout to
 * substitute. Called from inside a handler body (which only runs
 * per-request, after compile() already finished): the registry already has
 * the answer, so this returns the resolved path string directly.
 */
export function linkTo(target: Descriptor | string): string {
  if (typeof target === "string") return target;
  const resolved = linkRegistry.get(target);
  if (resolved !== undefined) return resolved;
  return { __servableRef: "link", target } as unknown as string;
}

export function warn(message: string): void {
  recordWarning(message);
}

/**
 * Renders markdown to an HTML string, synchronously -- same helper as
 * fileable's markdownToHtml(), same caveat: assumes no async extensions are
 * registered on the shared `marked` instance.
 */
export function markdownToHtml(text: string): string {
  return marked.parse(text) as string;
}

export interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Formats a Set-Cookie header *value* -- pass it to `headers`/`Response`, doesn't set anything itself. */
export function setCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.path !== undefined) parts.push(`Path=${options.path}`);
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires !== undefined) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite !== undefined) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

export interface SseEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

function formatSseEvent(event: SseEvent | string): string {
  const e = typeof event === "string" ? { data: event } : event;
  let out = "";
  if (e.id !== undefined) out += `id: ${e.id}\n`;
  if (e.event !== undefined) out += `event: ${e.event}\n`;
  if (e.retry !== undefined) out += `retry: ${e.retry}\n`;
  for (const line of e.data.split("\n")) out += `data: ${line}\n`;
  return out + "\n";
}

/** Wraps an async generator/iterable of events into a proper text/event-stream Response. */
export function sse(source: AsyncIterable<SseEvent | string>): globalThis.Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of source) controller.enqueue(encoder.encode(formatSseEvent(event)));
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
  });
  return new globalThis.Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

/** Wraps any AsyncIterable<Uint8Array | string> into a ReadableStream-backed Response. */
export function streamBody(source: AsyncIterable<Uint8Array | string>, init: ResponseInit = {}): globalThis.Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of source) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
  });
  return new globalThis.Response(stream, init);
}

interface DenoLike {
  upgradeWebSocket(req: Request): { socket: WebSocket; response: globalThis.Response };
}

/**
 * Abstracts WebSocket-upgrade mechanics across runtimes -- every modern
 * runtime models an upgrade as still returning a `Response`-like value
 * (status 101, socket attached), just with different APIs to get there.
 * `upgradeWebSocket()` is `async` uniformly (Deno/Workers resolve
 * trivially fast; Node's handshake is genuinely callback/promise-based --
 * `wss.handleUpgrade()` has no synchronous form -- so making every branch
 * async, rather than only Node's, keeps one signature instead of two).
 *
 * - **Deno**: `Deno.upgradeWebSocket(req)`, feature-detected.
 * - **Cloudflare Workers**: `WebSocketPair`, feature-detected.
 * - **Node**: delegates to `leserve`'s `upgradeRawSocket()` (lazily
 *   imported -- servable's core stays portable across runtimes and never
 *   pays for a Node-only dependency unless this branch actually runs),
 *   reached via `req.raw` -- the raw `IncomingMessage` servable's own
 *   `adapters/node.js` attaches to every `Request` it constructs (via
 *   `leserve`'s own `toWebRequest(req, { attachRaw: true })`, the same
 *   conversion `leserve`'s `serve()` uses internally). The socket
 *   servable's Node branch resolves is a `ws` library `WebSocket`
 *   (EventEmitter-based, `.on('message', ...)`), not the DOM
 *   `EventTarget`-style `WebSocket` Deno/Workers hand back
 *   (`.addEventListener('message', ...)`) -- `ws` also implements the
 *   `.addEventListener` compatibility shim, but code that branches on
 *   `instanceof WebSocket` will not treat them as the same class.
 */
export async function upgradeWebSocket(req: Request): Promise<{ socket: WebSocket; response: globalThis.Response }> {
  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno && typeof deno.upgradeWebSocket === "function") {
    return deno.upgradeWebSocket(req);
  }
  const WebSocketPairCtor = (globalThis as { WebSocketPair?: new () => [WebSocket, WebSocket] }).WebSocketPair;
  if (typeof WebSocketPairCtor === "function") {
    const [client, server] = new WebSocketPairCtor();
    (server as unknown as { accept: () => void }).accept();
    const response = new globalThis.Response(null, {
      status: 101,
      // Cloudflare Workers-specific Response property, not in the standard
      // ResponseInit type -- cast is unavoidable without Workers' own types.
      ...({ webSocket: client } as Record<string, unknown>),
    } as ResponseInit);
    return { socket: server, response };
  }
  const raw = (req as unknown as { raw?: unknown }).raw;
  if (raw) {
    const { upgradeRawSocket, WEBSOCKET_UPGRADE_RESPONSE } = await import("leserve/websocket");
    const socket = await upgradeRawSocket(raw);
    return {
      socket: socket as unknown as WebSocket,
      response: WEBSOCKET_UPGRADE_RESPONSE as unknown as globalThis.Response,
    };
  }
  throw new ServableError(
    'upgradeWebSocket() found no raw Node request to upgrade (no `.raw` on this Request) -- make sure this is ' +
      "running under @johnhenry/servable/adapters/node's serve(), which attaches it automatically. On any other " +
      "runtime this branch shouldn't be reached at all (Deno/Cloudflare Workers are handled above).",
    "upgradeWebSocket()",
  );
}
