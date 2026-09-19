import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { compile } from "../src/compile.js";
import { serve } from "../adapters/node.js";
import { ErrorBoundary, Group, Redirect, Route, Router, Use } from "../src/components.js";
import { sse, streamBody } from "../src/api.js";

async function withServer(tree: unknown, run: (base: string) => Promise<void>): Promise<void> {
  const compiled = await compile(tree);
  const server = serve(compiled, { port: 0 });
  await new Promise<void>((resolvePromise) => server.once("listening", () => resolvePromise()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
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
    const res = await fetch(`${base}/static/index.html`);
    assert.equal(await res.text(), "mounted");
  });
});
