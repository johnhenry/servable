import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { compile } from "../src/compile.js";
import { Group, Route, Router } from "../src/components.js";

test("handler=\"./module.js\" imports the module and uses its default export", async () => {
  const handlerPath = join(process.cwd(), "test/fixtures/handler.mjs");
  const compiled = await compile(Router({ children: Route({ path: "/x", method: "GET", handler: handlerPath }) }));
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(await res.text(), "from imported handler module");
});

test("<Group from=\"glob\"> synthesizes one Route per named HTTP-method export", async () => {
  const pattern = join(process.cwd(), "test/fixtures/routes/**/*.mjs");
  const compiled = await compile(Router({ children: Group({ prefix: "/api", from: pattern }) }));

  const rootGet = await compiled.fetch(new Request("http://x/api/index"));
  assert.equal(await rootGet.text(), "root index GET");

  const usersGet = await compiled.fetch(new Request("http://x/api/users/list"));
  assert.equal(await usersGet.text(), "users list GET");

  const usersPost = await compiled.fetch(new Request("http://x/api/users/list", { method: "POST" }));
  assert.equal(usersPost.status, 201);
  assert.equal(await usersPost.text(), "users list POST");
});

test("<Group from> file-based routing preserves subdirectory structure instead of flattening to a basename", async () => {
  const pattern = join(process.cwd(), "test/fixtures/routes/**/*.mjs");
  const compiled = await compile(Router({ children: Group({ prefix: "/api", from: pattern }) }));
  // If this collapsed to bare basenames, "users/list.mjs" and a
  // (nonexistent, but this proves the shape) sibling "list.mjs" at the root
  // would collide -- asserting the nested path exists is the real guard.
  const res = await compiled.fetch(new Request("http://x/api/users/list"));
  assert.equal(res.status, 200);
});

test("any other promise-valued prop (future-proofing) is generically awaited and replaced", async () => {
  const tree = Router({
    children: Route({ path: "/x", method: Promise.resolve("POST") as unknown as string, children: ["x"] }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x", { method: "POST" }));
  assert.equal(res.status, 200);
});
