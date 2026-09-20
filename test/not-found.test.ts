import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";
import { Group, NotFound, Route, Router, Use } from "../src/components.js";

test("no route matches, no NotFound declared anywhere -> plain 404", async () => {
  const compiled = await compile(Router({ children: Route({ path: "/x", method: "GET", children: ["x"] }) }));
  const res = await compiled.fetch(new Request("http://x/nope"));
  assert.equal(res.status, 404);
});

test("a scoped NotFound is used for requests matching that scope's prefix", async () => {
  const tree = Router({
    children: [
      Group({ prefix: "/admin", children: [Route({ path: "/x", method: "GET", children: ["x"] }), NotFound({ children: ["admin missing"] })] }),
      NotFound({ children: ["root missing"] }),
    ],
  });
  const compiled = await compile(tree);
  const adminRes = await compiled.fetch(new Request("http://x/admin/nope"));
  assert.equal(await adminRes.text(), "admin missing");
  const rootRes = await compiled.fetch(new Request("http://x/elsewhere"));
  assert.equal(await rootRes.text(), "root missing");
});

test("a scope with no NotFound of its own bubbles out to the nearest ancestor's", async () => {
  const tree = Router({
    children: [
      Group({ prefix: "/api", children: Group({ prefix: "/v1", children: Route({ path: "/x", method: "GET", children: ["x"] }) }) }),
      NotFound({ children: ["root missing"] }),
    ],
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/api/v1/nope"));
  assert.equal(await res.text(), "root missing");
});

test("a NotFound handler function is called just like a Route handler", async () => {
  const tree = Router({ children: NotFound({ handler: () => new Response("dynamic 404", { status: 404 }) }) });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/anything"));
  assert.equal(await res.text(), "dynamic 404");
});

test("the scope's Use/ErrorBoundary chain wraps its own NotFound too", async () => {
  const tree = Router({
    children: Use({
      middleware: async (req: Request, ctx: unknown, next: () => Promise<Response>) => {
        const res = await next();
        res.headers.set("X-Wrapped", "1");
        return res;
      },
      children: NotFound({ children: ["missing"] }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/anything"));
  assert.equal(res.headers.get("X-Wrapped"), "1");
});
