import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { compile } from "../src/compile.js";
import { serve } from "../adapters/node.js";
import { ErrorBoundary, Group, Redirect, Route, Router, Use } from "../src/components.js";
import { sse, streamBody, upgradeWebSocket } from "../src/api.js";

async function withServer(tree: unknown, run: (base: string) => Promise<void>): Promise<void> {
  const compiled = await compile(tree);
  // serve() returns its handle synchronously, before `listen()` completes
  // in the background -- capture it first, then wait for onListen to learn
  // the real (port: 0 -> OS-assigned) port, same order leserve's own
  // serveReady() test helper uses and for the same reason.
  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const handle = serve(compiled, { port: 0, onListen: (info) => resolvePort(info.port) });
  const port = await portPromise;
  try {
    await run(`http://localhost:${port}`);
  } finally {
    await handle[Symbol.asyncDispose]();
  }
}

test("a real HTTP round-trip: static string, JSON, dynamic handler", async () => {
  const tree = Router({
    children: [
      Route({ path: "/hello", method: "GET", children: ["Hello, world!"] }),
      Route({ path: "/json", method: "GET", children: [{ ok: true }] }),
      Route({
        path: "/users/:id",
        method: "GET",
        handler: (req: Request, ctx: { params: Record<string, string | undefined> }) =>
          new Response(`user ${ctx.params.id}`),
      }),
    ],
  });
  await withServer(tree, async (base) => {
    assert.equal(await (await fetch(`${base}/hello`)).text(), "Hello, world!");
    assert.deepEqual(await (await fetch(`${base}/json`)).json(), { ok: true });
    assert.equal(await (await fetch(`${base}/users/7`)).text(), "user 7");
  });
});

test("middleware short-circuit (401) over real HTTP", async () => {
  const tree = Router({
    children: Use({
      middleware: async () => new Response("blocked", { status: 401 }),
      children: Route({ path: "/x", method: "GET", children: ["never"] }),
    }),
  });
  await withServer(tree, async (base) => {
    const res = await fetch(`${base}/x`);
    assert.equal(res.status, 401);
  });
});

test("ErrorBoundary catching a thrown error over real HTTP", async () => {
  const tree = Router({
    children: ErrorBoundary({
      handler: (error: unknown) => new Response(`caught: ${(error as Error).message}`, { status: 500 }),
      children: Route({
        path: "/boom",
        method: "GET",
        handler: () => {
          throw new Error("kaboom");
        },
      }),
    }),
  });
  await withServer(tree, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "caught: kaboom");
  });
});

test("Redirect over real HTTP", async () => {
  const tree = Router({ children: Redirect({ from: "/old", to: "/new", status: 302 }) });
  await withServer(tree, async (base) => {
    const res = await fetch(`${base}/old`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/new");
  });
});

test("a ranged request against a real file, byte-exact", async () => {
  const fixture = join(process.cwd(), "test/fixtures/range-test.txt");
  const tree = Router({ children: Route({ path: "/file", method: "GET", src: fixture }) });
  await withServer(tree, async (base) => {
    const full = await fetch(`${base}/file`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(await full.text(), "0123456789\n");

    const ranged = await fetch(`${base}/file`, { headers: { Range: "bytes=0-4" } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), "01234");
  });
});

test("an SSE stream is consumed to completion over real HTTP", async () => {
  async function* events() {
    yield "first";
    yield "second";
  }
  const tree = Router({ children: Route({ path: "/events", method: "GET", handler: () => sse(events()) }) });
  await withServer(tree, async (base) => {
    const res = await fetch(`${base}/events`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.match(text, /data: first/);
    assert.match(text, /data: second/);
  });
});

test("a plain streamed body is consumed to completion over real HTTP", async () => {
  async function* chunks() {
    yield "chunk-a-";
    yield "chunk-b";
  }
  const tree = Router({ children: Route({ path: "/stream", method: "GET", handler: () => streamBody(chunks()) }) });
  await withServer(tree, async (base) => {
    const res = await fetch(`${base}/stream`);
    assert.equal(await res.text(), "chunk-a-chunk-b");
  });
});

test("mounting a fileable tree serves it over real HTTP too", async () => {
  const { Dir, File } = await import("@johnhenry/fileable");
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["mounted"] })] });
  const tree = Router({ children: Group({ prefix: "/static", from: site }) });
  await withServer(tree, async (base) => {
    const res = await fetch(`${base}/static/dist/index.html`);
    assert.equal(await res.text(), "mounted");
  });
});

test(
  "upgradeWebSocket() works end-to-end on the real Node adapter -- a real client WebSocket, real echo round-trip",
  // The *client* WebSocket global (used here only to drive the test, not
  // by the library itself -- the server-side upgrade delegates to leserve's
  // `ws`-library-based socket regardless) isn't available until Node 22;
  // this package's own engines range goes down to 18.19, and CI confirmed
  // Node 18/20 both throw "WebSocket is not defined" constructing it.
  { skip: typeof WebSocket === "undefined" },
  async () => {
  const tree = Router({
    children: Route({
      path: "/ws",
      method: "GET",
      handler: async (req: Request) => {
        const { socket, response } = await upgradeWebSocket(req);
        // The Node branch resolves a `ws` library socket (EventEmitter-
        // based, `.on(...)`), not the DOM EventTarget-style WebSocket the
        // declared return type promises for Deno/Workers parity -- see
        // upgradeWebSocket()'s own doc comment in api.ts.
        const rawSocket = socket as unknown as { on: (event: string, listener: (data: unknown) => void) => void; send: (data: unknown) => void };
        rawSocket.on("message", (data: unknown) => {
          rawSocket.send(`echo: ${String(data)}`);
        });
        return response;
      },
    }),
  });

  const compiled = await compile(tree);
  let resolvePort: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const handle = serve(compiled, { port: 0, onListen: (info) => resolvePort(info.port) });
  const port = await portPromise;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.addEventListener("open", () => ws.send("hi"));
      ws.addEventListener("message", (event) => {
        try {
          assert.equal(event.data, "echo: hi");
          ws.close();
          resolvePromise();
        } catch (err) {
          reject(err);
        }
      });
      ws.addEventListener("error", (event) => reject(new Error(String((event as { message?: string }).message))));
    });
  } finally {
    await handle[Symbol.asyncDispose]();
  }
});
