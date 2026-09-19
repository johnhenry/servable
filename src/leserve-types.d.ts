/**
 * `leserve` is plain JS (JSDoc-typed, no `.d.ts` build step) -- these are
 * hand-written ambient declarations for the exact shapes servable actually
 * uses (`adapters/node.ts`, `api.ts`'s `upgradeWebSocket()`), not a full
 * mirror of leserve's public surface. Keep in sync with leserve's own
 * JSDoc if either changes.
 */
declare module "leserve" {
  export interface ServeOptions {
    port?: number;
    hostname?: string;
    cert?: string;
    key?: string;
    signal?: AbortSignal;
    onListen?: (info: { path: string; port: number }) => void;
  }
  export interface ServeHandle {
    readonly finished: Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
  }
  export type ServeHandler = (request: Request, context?: unknown) => Response | Promise<Response>;
  export default function serve(handler: ServeHandler, options?: ServeOptions): ServeHandle;
}

declare module "leserve/websocket" {
  // The `ws` library's WebSocket (EventEmitter-based, `.on('message', ...)`)
  // -- structurally typed here rather than importing `ws`'s own types, to
  // avoid an extra type-only devDependency for one return type.
  export interface RawWebSocket {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    send(data: unknown): void;
    close(code?: number, reason?: string): void;
  }
  export function upgradeRawSocket(raw: unknown): Promise<RawWebSocket>;
  export const WEBSOCKET_UPGRADE_RESPONSE: { status: 101 };
}

declare module "leserve/trailers" {
  export function setTrailers(response: Response, trailers: HeadersInit | Promise<HeadersInit>): void;
  export function getTrailers(response: Response): Promise<HeadersInit> | undefined;
}
