import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";
import { Redirect, Router, Use } from "../src/components.js";

test("a matching Redirect returns the configured status and Location", async () => {
  const compiled = await compile(Router({ children: Redirect({ from: "/old", to: "/new", status: 302 }) }));
  const res = await compiled.fetch(new Request("http://x/old", { redirect: "manual" }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/new");
});

test("Redirect's default status is 301", async () => {
  const compiled = await compile(Router({ children: Redirect({ from: "/old", to: "/new" }) }));
  const res = await compiled.fetch(new Request("http://x/old", { redirect: "manual" }));
  assert.equal(res.status, 301);
});

test("a Redirect nested inside <Use> is wrapped by it too, same as a Route", async () => {
  const tree = Router({
    children: Use({
      middleware: async (req: Request, next: () => Promise<Response>) => {
        const res = await next();
        res.headers.set("X-Wrapped", "1");
        return res;
      },
      children: Redirect({ from: "/old", to: "/new" }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/old", { redirect: "manual" }));
  assert.equal(res.headers.get("X-Wrapped"), "1");
});
