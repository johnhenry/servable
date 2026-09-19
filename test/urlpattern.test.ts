import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";
import { Route, Router } from "../src/components.js";
import { compilePath, URLPatternImpl } from "../src/urlpattern.js";

test("compilePath compiles a string path into a URLPattern", () => {
  const pattern = compilePath("/users/:id");
  assert.ok(pattern instanceof URLPatternImpl);
  assert.ok(pattern.test("http://x/users/42"));
});

test("compilePath passes an already-constructed URLPattern through unchanged", () => {
  const pattern = new URLPatternImpl({ pathname: "/a/:b" });
  assert.equal(compilePath(pattern), pattern);
});

test("named params extract into ctx.params via the URLPattern's own groups object", async () => {
  const tree = Router({
    children: Route({
      path: "/users/:id/posts/:postId",
      method: "GET",
      handler: (req: Request, ctx: { params: Record<string, string | undefined> }) =>
        Response.json(ctx.params),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/users/42/posts/7"));
  assert.deepEqual(await res.json(), { id: "42", postId: "7" });
});

test("wildcard patterns match", async () => {
  const tree = Router({
    children: Route({ path: "/assets/*", method: "GET", children: ["asset"] }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/assets/img/logo.png"));
  assert.equal(res.status, 200);
});

test("a raw URLPattern instance as `path` is used as-is (advanced full-URL matching)", async () => {
  const pattern = new URLPatternImpl({ hostname: "api.example.com", pathname: "/x" });
  const tree = Router({ children: Route({ path: pattern, method: "GET", children: ["matched"] }) });
  const compiled = await compile(tree);
  const matching = await compiled.fetch(new Request("http://api.example.com/x"));
  assert.equal(await matching.text(), "matched");
  const notMatching = await compiled.fetch(new Request("http://other.example.com/x"));
  assert.equal(notMatching.status, 404);
});
