import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Dir, File } from "@johnhenry/fileable";
import { compile } from "../src/compile.js";
import { Group, Router } from "../src/components.js";

// fileable's Fragment marker (`Symbol.for("fileable.fragment")`) and its
// FILEABLE_DESCRIPTOR brand (`Symbol.for("fileable.descriptor")`) are both
// global-symbol-registry keys, not module-scoped exports of fileable's main
// entrypoint (only its jsx-runtime re-exports the former, as a raw JSX
// `type` value, with no non-JSX factory function alongside it) -- so a
// Fragment-rooted tree is built by hand here, matching exactly the shape
// fileable's own `jsx()` produces for `<>...</>`.
const FILEABLE_FRAGMENT = Symbol.for("fileable.fragment");
const FILEABLE_DESCRIPTOR = Symbol.for("fileable.descriptor");
function fragment(children: unknown[]) {
  return { tag: FILEABLE_FRAGMENT, props: {} as Record<string, unknown>, children, [FILEABLE_DESCRIPTOR]: true };
}

test("mounting a fileable tree serves its contents at the Group's prefix, keeping the root's own name", async () => {
  const site = Dir({
    name: "dist",
    children: [File({ name: "index.html", children: ["<h1>Home</h1>"] })],
  });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const res = await compiled.fetch(new Request("http://x/static/dist/index.html"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.equal(await res.text(), "<h1>Home</h1>");
  // The old, stripped path must NOT also work -- there is exactly one
  // correct location now, not two.
  assert.equal((await compiled.fetch(new Request("http://x/static/index.html"))).status, 404);
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
  // posixDirname("/dist/index.html") is "/dist" (no trailing slash -- posix
  // dirname only has one for the true root "/").
  const rootRes = await compiled.fetch(new Request("http://x/static/dist"));
  assert.equal(await rootRes.text(), "home");
  const docsRes = await compiled.fetch(new Request("http://x/static/dist/docs"));
  assert.equal(await docsRes.text(), "docs home");
});

test("a fileable symlink artifact becomes a Redirect, not a duplicate route", async () => {
  const target = File({ name: "hello.html", children: ["HELLO"] });
  const link = File({ name: "latest", symlink: target });
  const site = Dir({ name: "dist", children: [target, link] });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const res = await compiled.fetch(new Request("http://x/static/dist/latest", { redirect: "manual" }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/static/dist/hello.html");
});

test("a fileable src-backed binary artifact (a real PNG) mounts byte-exact", async () => {
  const pngPath = join(process.cwd(), "test/fixtures/logo.png");
  const original = await readFile(pngPath);
  const site = Dir({ name: "dist", children: [File({ name: "logo.png", src: pngPath })] });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  const res = await compiled.fetch(new Request("http://x/static/dist/logo.png"));
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
  assert.equal(await (await compiled.fetch(new Request("http://x/static/dist/index.html"))).text(), "mounted");
  assert.equal(await (await compiled.fetch(new Request("http://x/static/extra"))).text(), "explicit");
});

test("a fileable tree placed directly as a Group's raw child mounts the same way from={tree} does", async () => {
  // The actual point: no `from=` at all -- Dir()'s result sits directly in
  // Group's children, same as any other nested servable primitive would.
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["direct child"] })] });
  const tree = Router({ children: Group({ prefix: "/static", children: [site] }) });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/static/dist/index.html"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "direct child");
});

test("a fileable tree as a raw child of Router (no Group at all) mounts at the root, name and all", async () => {
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["root mount"] })] });
  const tree = Router({ children: [site] });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://x/dist/index.html"))).text(), "root mount");
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
  assert.equal(await (await compiled.fetch(new Request("http://x/static/dist/index.html"))).text(), "mounted");
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
  assert.equal(await (await first.fetch(new Request("http://x/static/dist/index.html"))).text(), "stable");
  assert.equal(await (await second.fetch(new Request("http://x/static/dist/index.html"))).text(), "stable");
});

test("no folder name wanted -- a Fragment mount root has no name of its own, so its children keep only their own names", async () => {
  const site = fragment([
    File({ name: "index.html", children: ["home"] }),
    File({ name: "about.html", children: ["about"] }),
  ]);
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));
  assert.equal(await (await compiled.fetch(new Request("http://x/static/index.html"))).text(), "home");
  assert.equal(await (await compiled.fetch(new Request("http://x/static/about.html"))).text(), "about");
});

test("a bare File (not wrapped in a Dir) with an explicit name keeps that name -- no duplicate-route crash at either resulting path", async () => {
  // Regression guard for a real bug found while adding the nameless-root
  // case below: an index.html-named root used to collapse to the exact
  // same "/" route the "index.html also serves its directory" rule
  // produced, a byte-identical duplicate that crashed with
  // `duplicate route: GET /`. A NAMED root file no longer collapses to "/"
  // at all (its name is part of the path now) -- this exercises the case
  // that CAN still collide, an index.html-named root, to prove the guard
  // still holds under the new naming rule.
  const compiled = await compile(
    Router({ children: Group({ prefix: "/static", children: [File({ name: "index.html", children: ["<h1>Home</h1>"] })] }) }),
  );
  const named = await compiled.fetch(new Request("http://x/static/index.html"));
  assert.equal(named.status, 200);
  assert.equal(await named.text(), "<h1>Home</h1>");
  const dirStyle = await compiled.fetch(new Request("http://x/static"));
  assert.equal(dirStyle.status, 200);
  assert.equal(await dirStyle.text(), "<h1>Home</h1>");
});

test("a bare File with no name= at all mounts directly as a Group child, serving at the Group's own prefix", async () => {
  // Unlike the named case above, there is no developer-supplied name here
  // to preserve -- nothing to put in the URL, so it maps straight to the
  // Group's own prefix.
  const compiled = await compile(
    Router({ children: Group({ prefix: "/static", children: [File({ children: ["<h1>Nameless</h1>"] })] }) }),
  );
  const res = await compiled.fetch(new Request("http://x/static"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /text\/html/);
  assert.equal(await res.text(), "<h1>Nameless</h1>");
});

test("a bare File with no name= is still just a Route target -- unmatched paths under the prefix still 404", async () => {
  const compiled = await compile(
    Router({ children: Group({ prefix: "/static", children: [File({ children: ["hi"] })] }) }),
  );
  const res = await compiled.fetch(new Request("http://x/static/other"));
  assert.equal(res.status, 404);
});

test("a fileable descriptor nested under a Route (not Router/Group) throws a clear compile-time error, instead of silently serializing as markup text", async () => {
  const { Route } = await import("../src/components.js");
  await assert.rejects(
    () =>
      compile(
        Router({
          children: Route({
            path: "/oops",
            method: "GET",
            children: [File({ name: "x.html", children: ["content"] })],
          }),
        }),
      ),
    /fileable <file> descriptor can't be used here, under <route>/,
  );
});

test("an encode=\"zip\" subtree inside a mounted fileable tree is skipped with a warning, not mounted", async () => {
  const site = Dir({
    name: "dist",
    children: [
      File({ name: "index.html", children: ["<h1>Home</h1>"] }),
      Dir({
        name: "bundle",
        encode: "zip",
        children: [File({ name: "a.txt", children: ["A"] })],
      }),
    ],
  });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));

  // The loose sibling still mounts normally.
  const home = await compiled.fetch(new Request("http://x/static/dist/index.html"));
  assert.equal(home.status, 200);

  // Nothing inside the zip subtree becomes a route -- neither the
  // container's own would-be path nor the file inside it.
  assert.equal((await compiled.fetch(new Request("http://x/static/dist/bundle.zip"))).status, 404);
  assert.equal((await compiled.fetch(new Request("http://x/static/dist/a.txt"))).status, 404);

  assert.ok(compiled.warnings.some((w) => w.includes('encode="zip"') && w.includes('"a.txt"')));
});

test("an encode=\"wbn\" subtree inside a mounted fileable tree is skipped with a warning, not mounted", async () => {
  const site = Dir({
    name: "dist",
    children: [
      Dir({
        name: "app",
        encode: "wbn",
        children: [File({ name: "index.html", children: ["<h1>Bundled</h1>"] })],
      }),
    ],
  });
  const compiled = await compile(Router({ children: Group({ prefix: "/static", from: site }) }));

  assert.equal((await compiled.fetch(new Request("http://x/static/dist/app.wbn"))).status, 404);
  assert.equal((await compiled.fetch(new Request("http://x/static/dist/index.html"))).status, 404);

  assert.ok(compiled.warnings.some((w) => w.includes('encode="wbn"') && w.includes("index.html")));
});
