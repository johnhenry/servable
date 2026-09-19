/**
 * Node adapter -- the real engineering work among the four adapters. Node's
 * `node:http` speaks `IncomingMessage`/`ServerResponse`, not `Request`/
 * `Response`, so this bridges both directions explicitly: headers, streamed
 * bodies, and (best-effort) HTTP trailers via `pendingTrailers` (see
 * compile.ts -- trailers aren't part of the Fetch Response model at all,
 * so this is the one adapter that can actually transmit them, via Node's
 * own `res.addTrailers()`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pendingTrailers } from "../src/compile.js";
import type { CompileResult } from "../src/types.js";

function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

function getSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") return withGetSetCookie.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
  const headerLines: [string, string][] = [];
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue; // handled separately, one line per cookie
    headerLines.push([key, value]);
  }
  for (const cookie of getSetCookies(response.headers)) headerLines.push(["set-cookie", cookie]);

  res.writeHead(response.status, Object.fromEntries(headerLines));

  if (response.body) {
    await new Promise<void>((resolvePromise, reject) => {
      const nodeStream = Readable.fromWeb(response.body as never);
      nodeStream.on("error", reject);
      nodeStream.on("end", resolvePromise);
      nodeStream.pipe(res, { end: false });
    });
  }

  const trailerPromise = pendingTrailers.get(response);
  if (trailerPromise) {
    const trailers = await trailerPromise;
    res.addTrailers(Object.fromEntries(trailers.entries()));
  }
  res.end();
}

export interface ListenOptions {
  port?: number;
  hostname?: string;
}

/** Wraps a compiled dispatcher into a real `node:http` server. */
export function serve(compiled: CompileResult, options: ListenOptions = {}): Server {
  for (const message of compiled.warnings) console.warn(`servable: warning: ${message}`);
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const request = toRequest(req);
        const response = await compiled.fetch(request);
        await sendResponse(response, res);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Internal Server Error\n${(error as Error).stack ?? String(error)}`);
      }
    })();
  });
  server.listen(options.port ?? 0, options.hostname);
  return server;
}
