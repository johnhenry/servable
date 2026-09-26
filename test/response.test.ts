import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";
import { Group, Response as ResponseTag, Route, Router } from "../src/components.js";
import { ServableError } from "../src/types.js";

async function get(app: unknown, path: string, init: RequestInit = {}) {
  const compiled = await compile(app);
  return compiled.fetch(new Request(`http://x${path}`, init));
}

test("compile() on a bare <Group> with no prefix (no Router wrapper either) makes its Route matchable (issue #4)", async () => {
  // The exact repro from #4: `Group({ children: Route(...) })` -- no
  // prefix prop, no Router wrapper -- used to compile to a dead route
  // table (posixJoin("", "") -> "." leaking into every Route's joined
  // path). end-to-end through compile()/fetch(), not just layout().
  const app = Group({ children: Route({ method: "GET", path: "/hi", children: ["hi"] }) });
  const res = await get(app, "/hi");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hi");
});

test("a bare string child -> 200 text/plain", async () => {
  const res = await get(Router({ children: Route({ path: "/x", method: "GET", children: ["hello"] }) }), "/x");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/plain/);
  assert.equal(await res.text(), "hello");
});

test("JSX markup children serialize to HTML", async () => {
  const { jsx } = await import("../src/jsx-runtime.js");
  const markup = jsx("h1", { children: "About" });
  const res = await get(Router({ children: Route({ path: "/x", method: "GET", children: [markup] }) }), "/x");
  assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.equal(await res.text(), "<h1>About</h1>");
});

test("plain object children -> Response.json shape", async () => {
  const res = await get(Router({ children: Route({ path: "/x", method: "GET", children: [{ a: 1 }] }) }), "/x");
  assert.match(res.headers.get("content-type")!, /application\/json/);
  assert.deepEqual(await res.json(), { a: 1 });
});

test("a real Response passed as children is passed through untouched", async () => {
  const marker = new Response("raw", { status: 202, headers: { "X-Marker": "1" } });
  const res = await get(Router({ children: Route({ path: "/x", method: "GET", children: [marker] }) }), "/x");
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("X-Marker"), "1");
});

test("a Blob child is handed straight to Response, inferring nothing extra", async () => {
  const blob = new Blob(["blob body"], { type: "application/custom" });
  const res = await get(Router({ children: Route({ path: "/x", method: "GET", children: [blob] }) }), "/x");
  assert.equal(res.headers.get("content-type"), "application/custom");
  assert.equal(await res.text(), "blob body");
});

test("no children and no handler/src -> empty 200", async () => {
  const res = await get(Router({ children: Route({ path: "/ping", method: "GET" }) }), "/ping");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("<Response> as children sets status/headers declaratively, no handler needed", async () => {
  const tree = Router({
    children: Route({
      path: "/x",
      method: "POST",
      children: [ResponseTag({ status: 201, headers: { Location: "/x/123" }, children: ["created"] })],
    }),
  });
  const res = await get(tree, "/x", { method: "POST" });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Location"), "/x/123");
  assert.equal(await res.text(), "created");
});

test("<Response> as children plus Route's own headers prop throws -- one way to say it", async () => {
  const tree = Router({
    children: Route({
      path: "/x",
      method: "GET",
      headers: { "X-Extra": "1" },
      children: [ResponseTag({ status: 200, children: ["x"] })],
    }),
  });
  await assert.rejects(() => get(tree, "/x"), ServableError);
});

test("a handler function is called per request and its Response used directly", async () => {
  const tree = Router({
    children: Route({
      path: "/users/:id",
      method: "GET",
      handler: (req: Request, ctx: { params: Record<string, string | undefined> }) =>
        new Response(`user ${ctx.params.id}`),
    }),
  });
  const res = await get(tree, "/users/42");
  assert.equal(await res.text(), "user 42");
});

test("compile() called twice on the same tree object doesn't leak mutations (fileable's own bug class)", async () => {
  const tree = Router({ children: Route({ path: "/x", method: "GET", children: ["same"] }) });
  const first = await compile(tree);
  const second = await compile(tree);
  assert.equal(await (await first.fetch(new Request("http://x/x"))).text(), "same");
  assert.equal(await (await second.fetch(new Request("http://x/x"))).text(), "same");
});
