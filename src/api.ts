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
 * runtime models an upgrade as still returning a `Response` (status 101,
 * socket attached), just with different APIs to get there. Real support:
 * Deno (`Deno.upgradeWebSocket`) and Cloudflare Workers (`WebSocketPair`),
 * both feature-detected, both trivial since the platform already does the
 * hard work. Node has no built-in server-side WebSocket upgrade/framing at
 * all (only a client `WebSocket` global since v22) -- implementing that
 * from a raw socket correctly (handshake, opcodes, masking, fragmentation,
 * ping/pong, close frames) is real protocol work, not something to rush
 * inside this pass. Throws a clear, honest error there instead of shipping
 * an unverified bridge -- documented as a known v1 gap, not silently
 * unsupported.
 */
export function upgradeWebSocket(req: Request): { socket: WebSocket; response: globalThis.Response } {
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
  throw new ServableError(
    "upgradeWebSocket() has no Node implementation in this version -- Node has no built-in server-side " +
      "WebSocket upgrade/framing (only a client WebSocket global). Supported today: Deno, Cloudflare Workers.",
    "upgradeWebSocket()",
  );
}
