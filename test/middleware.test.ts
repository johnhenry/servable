import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";
import { Route, Router, Use } from "../src/components.js";

test("onion composition: outermost runs first going in, last coming out", async () => {
  const order: string[] = [];
  const mw = (label: string) => async (req: Request, ctx: unknown, next: () => Promise<Response>) => {
    order.push(`${label}-in`);
    const res = await next();
    order.push(`${label}-out`);
    return res;
  };
  const tree = Router({
    children: Use({
      middleware: mw("a"),
      children: Use({ middleware: mw("b"), children: Route({ path: "/x", method: "GET", children: ["x"] }) }),
    }),
  });
  const compiled = await compile(tree);
  await compiled.fetch(new Request("http://x/x"));
  assert.deepEqual(order, ["a-in", "b-in", "b-out", "a-out"]);
});

test("not calling next() short-circuits -- no special ceremony needed", async () => {
  const tree = Router({
    children: Use({
      middleware: async () => new Response("blocked", { status: 401 }),
      children: Route({ path: "/x", method: "GET", handler: () => new Response("should not run") }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "blocked");
});

test("a middleware can inspect/modify the final Response after next() resolves (only possible because handlers are Fetch-shaped, no mutable res)", async () => {
  const tree = Router({
    children: Use({
      middleware: async (req: Request, ctx: unknown, next: () => Promise<Response>) => {
        const res = await next();
        res.headers.set("X-Timing", "measured");
        return res;
      },
      children: Route({ path: "/x", method: "GET", children: ["x"] }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(res.headers.get("X-Timing"), "measured");
});
