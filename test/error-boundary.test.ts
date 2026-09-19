import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile.js";
import { ErrorBoundary, Route, Router, Use } from "../src/components.js";

test("nearest ErrorBoundary catches a throw from a handler", async () => {
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
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/boom"));
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "caught: kaboom");
});

test("nearest ErrorBoundary catches a throw from a Use middleware in the same chain too", async () => {
  const tree = Router({
    children: ErrorBoundary({
      handler: () => new Response("caught", { status: 500 }),
      children: Use({
        middleware: () => {
          throw new Error("middleware boom");
        },
        children: Route({ path: "/x", method: "GET", children: ["never"] }),
      }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(await res.text(), "caught");
});

test("an uncaught error propagates to the next ancestor boundary out, not the nearest one that already re-threw", async () => {
  const tree = Router({
    children: ErrorBoundary({
      handler: () => new Response("outer caught", { status: 500 }),
      children: ErrorBoundary({
        handler: (error: unknown) => {
          throw error; // deliberately re-throw
        },
        children: Route({
          path: "/x",
          method: "GET",
          handler: () => {
            throw new Error("deep boom");
          },
        }),
      }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(await res.text(), "outer caught");
});
