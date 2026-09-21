import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Dir, File } from "@johnhenry/fileable";
import { compile } from "../src/compile.js";
import { Group, Host, NotFound, Redirect, Route, Router } from "../src/components.js";
import { linkTo } from "../src/api.js";
import { ServableError } from "../src/types.js";

const fixtures = join(process.cwd(), "test/fixtures");

test("<Host name> matches only requests for that exact hostname", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Route({ path: "/x", method: "GET", children: ["a"] }) }),
      Host({ name: "b.example.com", children: Route({ path: "/x", method: "GET", children: ["b"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/x"))).text(), "a");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/x"))).text(), "b");
  assert.equal((await compiled.fetch(new Request("http://c.example.com/x"))).status, 404);
});

test("<Host pattern> supports wildcard hostname matching", async () => {
  const tree = Router({
    children: Host({ pattern: "*.example.com", children: Route({ path: "/x", method: "GET", children: ["wild"] }) }),
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://foo.example.com/x"))).text(), "wild");
  assert.equal((await compiled.fetch(new Request("http://foo.other.com/x"))).status, 404);
});

test("<Host> requires a name or pattern prop", async () => {
  await assert.rejects(() => compile(Router({ children: Host({ children: Route({ path: "/x", method: "GET" }) }) })), ServableError);
});

test("<Host> cannot be nested inside another <Host>", async () => {
  const tree = Router({
    children: Host({ name: "a.example.com", children: Host({ name: "b.example.com", children: [] }) }),
  });
  await assert.rejects(() => compile(tree), /cannot be nested inside another <Host>/);
});

test("a Route outside any Host matches every hostname (no hostname constraint, unchanged pre-Host behavior)", async () => {
  const compiled = await compile(Router({ children: Route({ path: "/x", method: "GET", children: ["anywhere"] }) }));
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/x"))).text(), "anywhere");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/x"))).text(), "anywhere");
});

test("Host + Group compose in both nesting orders", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Group({ prefix: "/api", children: Route({ path: "/x", method: "GET", children: ["host-then-group"] }) }) }),
      Group({ prefix: "/other", children: Host({ name: "b.example.com", children: Route({ path: "/x", method: "GET", children: ["group-then-host"] }) }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/api/x"))).text(), "host-then-group");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/other/x"))).text(), "group-then-host");
});

// --- Regression: path="/" under a Group inside a Host must accept both
// the bare prefix and a trailing slash, exactly like outside a Host ---
test('path="/" under a Group inside a Host matches both the bare prefix and a trailing slash', async () => {
  const tree = Router({
    children: Host({
      name: "a.example.com",
      children: Group({ prefix: "/api", children: Route({ path: "/", method: "GET", children: ["api root"] }) }),
    }),
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/api"))).text(), "api root");
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/api/"))).text(), "api root");
});

// --- Regression: linkTo() must resolve for a route inside a Host ---
test("linkTo() resolves the canonical path for a Route inside a Host", async () => {
  const target = Route({ path: "/target", method: "GET", children: ["target"] });
  const tree = Router({
    children: Host({
      name: "a.example.com",
      children: [target, Route({ path: "/from", method: "GET", children: [linkTo(target)] })],
    }),
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/from"))).text(), "/target");
});

// --- Regression: two sibling Hosts' own NotFound must not overwrite each other ---
test("sibling Hosts each get their own NotFound, not a shared/overwritten one", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: NotFound({ children: ["a missing"] }) }),
      Host({ name: "b.example.com", children: NotFound({ children: ["b missing"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/nope"))).text(), "a missing");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/nope"))).text(), "b missing");
});

// --- Regression: Redirect must be hostname-qualified too ---
test("Redirect inside a Host only fires for that hostname", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Redirect({ from: "/old", to: "/new" }) }),
      Host({ name: "b.example.com", children: Route({ path: "/old", method: "GET", children: ["b real content"] }) }),
    ],
  });
  const compiled = await compile(tree);
  const aRes = await compiled.fetch(new Request("http://a.example.com/old", { redirect: "manual" }));
  assert.equal(aRes.status, 301);
  assert.equal(aRes.headers.get("Location"), "/new");
  const bRes = await compiled.fetch(new Request("http://b.example.com/old"));
  assert.equal(await bRes.text(), "b real content");
});

// --- Regression: a literal <Router> nested inside a <Host> still threads hostname through ---
test("a literal <Router> nested inside a <Host> still qualifies its own Routes by hostname", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Router({ children: Route({ path: "/r", method: "GET", children: ["a router"] }) }) }),
      Host({ name: "b.example.com", children: Route({ path: "/*", method: "GET", children: ["b catch-all"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/r"))).text(), "a router");
  // Must NOT leak to b.example.com -- b's own catch-all should answer instead.
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/r"))).text(), "b catch-all");
});

// --- Regression: a promise-valued Route path is still hostname-qualified ---
test("a Route with a promise-valued path is hostname-qualified once resolved", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Route({ path: Promise.resolve("/p") as unknown as string, method: "GET", children: ["a promise"] }) }),
      Host({ name: "b.example.com", children: Route({ path: "/*", method: "GET", children: ["b catch-all"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/p"))).text(), "a promise");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/p"))).text(), "b catch-all");
});

// --- Regressions: every fileable/glob mounting path is hostname-qualified, not leaked ---
test("a raw fileable child of <Host> (no Group wrapper) is hostname-qualified", async () => {
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["a static"] })] });
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: site }),
      Host({ name: "b.example.com", children: Route({ path: "/*", method: "GET", children: ["b catch-all"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/dist/index.html"))).text(), "a static");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/dist/index.html"))).text(), "b catch-all");
});

test("Group from={fileableTree} inside a Host is hostname-qualified, not leaked to a sibling Host", async () => {
  const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["a static"] })] });
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Group({ prefix: "/static", from: site }) }),
      Host({ name: "b.example.com", children: Route({ path: "/*", method: "GET", children: ["b catch-all"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/static/dist/index.html"))).text(), "a static");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/static/dist/index.html"))).text(), "b catch-all");
});

test('Group from="glob" (file-based routing) inside a Host is hostname-qualified, not leaked', async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Group({ prefix: "/api", from: "test/fixtures/routes/**/*.mjs" }) }),
      Host({ name: "b.example.com", children: Route({ path: "/*", method: "GET", children: ["b catch-all"] }) }),
    ],
  });
  const compiled = await compile(tree, { cwd: process.cwd() });
  const aRes = await compiled.fetch(new Request("http://a.example.com/api/index"));
  assert.equal(aRes.status, 200);
  const bRes = await compiled.fetch(new Request("http://b.example.com/api/index"));
  assert.equal(await bRes.text(), "b catch-all");
});

test("Group from={array of paths} inside a Host is hostname-qualified, not leaked", async () => {
  // With no glob base to relativize against, an array match's route path is
  // computed relative to cwd (baseDir) -- resolve.ts:107-108 -- so an
  // absolute path under test/fixtures/routes lands at that full relative
  // path, not just its basename.
  const routeFile = join(process.cwd(), "test/fixtures/routes/index.mjs");
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Group({ prefix: "/api", from: [routeFile] }) }),
      Host({ name: "b.example.com", children: Route({ path: "/*", method: "GET", children: ["b catch-all"] }) }),
    ],
  });
  const compiled = await compile(tree, { cwd: process.cwd() });
  const aRes = await compiled.fetch(new Request("http://a.example.com/api/test/fixtures/routes/index"));
  assert.equal(aRes.status, 200);
  const bRes = await compiled.fetch(new Request("http://b.example.com/api/test/fixtures/routes/index"));
  assert.equal(await bRes.text(), "b catch-all");
});

test("sibling Hosts can reuse the exact same path -- dedup is hostname-aware, not just pathname-aware", async () => {
  const tree = Router({
    children: [
      Host({ name: "a.example.com", children: Route({ path: "/health", method: "GET", children: ["a healthy"] }) }),
      Host({ name: "b.example.com", children: Route({ path: "/health", method: "GET", children: ["b healthy"] }) }),
    ],
  });
  const compiled = await compile(tree);
  assert.equal(await (await compiled.fetch(new Request("http://a.example.com/health"))).text(), "a healthy");
  assert.equal(await (await compiled.fetch(new Request("http://b.example.com/health"))).text(), "b healthy");
});

test("the SAME path twice inside the SAME Host still throws duplicate route", async () => {
  const tree = Router({
    children: Host({
      name: "a.example.com",
      children: [Route({ path: "/x", method: "GET", children: ["1"] }), Route({ path: "/x", method: "GET", children: ["2"] })],
    }),
  });
  await assert.rejects(() => compile(tree), /duplicate route/);
});

test("binary fileable content mounted inside a Host round-trips byte-exact", async () => {
  // mount-fileable.ts doesn't thread compile()'s own `cwd` option through to
  // fileable's resolve() (it always calls fileable.resolve(built, {})) --
  // src= needs an absolute path here, matching mount-fileable.test.ts's own
  // established pattern for this exact reason.
  const original = await readFile(join(fixtures, "logo.png"));
  const site = Dir({ name: "assets", children: [File({ name: "logo.png", src: join(fixtures, "logo.png") })] });
  const tree = Router({ children: Host({ name: "a.example.com", children: Group({ prefix: "/img", from: site }) }) });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://a.example.com/img/assets/logo.png"));
  const served = Buffer.from(await res.arrayBuffer());
  assert.ok(served.equals(original));
});
