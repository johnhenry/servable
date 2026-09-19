import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Dir, File } from "@johnhenry/fileable";
import { compile } from "../src/compile.js";
import { Group, Router } from "../src/components.js";

test("mounting a fileable tree serves its contents at the Group's prefix, stripping the root's own name", async () => {
  const site = Dir({
    name: "dist",
    children: [File({ name: "index.html", children: ["<h1>Home</h1>"] })],
  });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const res = await compiled.fetch(new Request("http://x/static/index.html"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.equal(await res.text(), "<h1>Home</h1>");
});

test("a directory's index.html also serves at the directory's own path", async () => {
  const site = Dir({
    name: "dist",
    children: [
      File({ name: "index.html", children: ["home"] }),
      Dir({ name: "docs", children: [File({ name: "index.html", children: ["docs home"] })] }),
    ],
  });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const rootRes = await compiled.fetch(new Request("http://x/static/"));
  assert.equal(await rootRes.text(), "home");
  const docsRes = await compiled.fetch(new Request("http://x/static/docs"));
  assert.equal(await docsRes.text(), "docs home");
});

test("a fileable symlink artifact becomes a Redirect, not a duplicate route", async () => {
  const target = File({ name: "hello.html", children: ["HELLO"] });
  const link = File({ name: "latest", symlink: target });
  const site = Dir({ name: "dist", children: [target, link] });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const res = await compiled.fetch(new Request("http://x/static/latest", { redirect: "manual" }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/static/hello.html");
});

test("a fileable src-backed binary artifact (a real PNG) mounts byte-exact", async () => {
  const pngPath = join(process.cwd(), "test/fixtures/logo.png");
  const original = await readFile(pngPath);
  const site = Dir({ name: "dist", children: [File({ name: "logo.png", src: pngPath })] });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const res = await compiled.fetch(new Request("http://x/static/logo.png"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const served = Buffer.from(await res.arrayBuffer());
  assert.ok(served.equals(original));
});

test("Group from={fileableTree} composes with an explicit sibling Route in the same Group", async () => {
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["mounted"] })] });
  const { Route } = await import("../src/components.js");
  const tree = Router({
    children: Group({
      prefix: "/static",
      from: site,
      children: Route({ path: "/extra", method: "GET", children: ["explicit"] }),
    }),
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://x/static/index.html"))).text(), "mounted");
  assert.equal(await (await compiled.fetch(new Request("http://x/static/extra"))).text(), "explicit");
});

test("a fileable tree placed directly as a Group's raw child mounts the same way from={tree} does", async () => {
  // The actual point: no `from=` at all -- Dir()'s result sits directly in
  // Group's children, same as any other nested servable primitive would.
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["direct child"] })] });
  const tree = Router({ children: Group({ prefix: "/static", children: [site] }) });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/static/index.html"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "direct child");
});

test("a fileable tree as a raw child of Router (no Group at all) mounts at the root", async () => {
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["root mount"] })] });
  const tree = Router({ children: [site] });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://x/index.html"))).text(), "root mount");
});

test("a fileable tree as a raw child composes with an explicit sibling Route in the same Group", async () => {
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["mounted"] })] });
  const { Route } = await import("../src/components.js");
  const tree = Router({
    children: Group({
      prefix: "/static",
      children: [site, Route({ path: "/extra", method: "GET", children: ["explicit"] })],
    }),
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://x/static/index.html"))).text(), "mounted");
  assert.equal(await (await compiled.fetch(new Request("http://x/static/extra"))).text(), "explicit");
});

test("compile() called twice on the same tree with a raw fileable child doesn't leak mutations", async () => {
  // Regression guard for the actual bug found while building this: compile()
  // clones the tree before Build runs (see cloneDescriptorTree), and that
  // clone used to silently strip the FILEABLE_DESCRIPTOR brand by
  // reconstructing every descriptor-shaped value field-by-field -- so the
  // *second* compile() call would fail to recognize the same fileable tree
  // it correctly mounted on the first call.
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["stable"] })] });
  const tree = Router({ children: Group({ prefix: "/static", children: [site] }) });
  const first = await compile(tree);
  const second = await compile(tree);
  assert.equal(await (await first.fetch(new Request("http://x/static/index.html"))).text(), "stable");
  assert.equal(await (await second.fetch(new Request("http://x/static/index.html"))).text(), "stable");
});
