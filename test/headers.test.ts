import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHeaders, mergeHeadersInto } from "../src/headers-util.js";
import { compile } from "../src/compile.js";
import { Group, Route, Router } from "../src/components.js";

test("mergeHeaders accepts POJO, array-of-pairs, and a real Headers instance", () => {
  const merged = mergeHeaders({ "X-A": "1" }, [["X-B", "2"]], new Headers({ "X-C": "3" }));
  assert.equal(merged.get("X-A"), "1");
  assert.equal(merged.get("X-B"), "2");
  assert.equal(merged.get("X-C"), "3");
});

test("later layers override earlier ones for the same header, case-insensitively", () => {
  const merged = mergeHeaders({ "Content-Type": "text/plain" }, { "content-type": "text/html" });
  assert.equal(merged.get("Content-Type"), "text/html");
  assert.equal(Array.from(merged.entries()).filter(([k]) => k === "content-type").length, 1);
});

test("Set-Cookie accumulates across layers instead of overwriting (the one header the Fetch spec itself special-cases)", () => {
  const merged = mergeHeaders({ "Set-Cookie": "a=1" }, { "Set-Cookie": "b=2" });
  const cookies = merged.getSetCookie();
  assert.deepEqual(cookies.sort(), ["a=1", "b=2"]);
});

test("a naive object-spread would have gotten both of these wrong -- direct regression guard", () => {
  const target = new Headers();
  mergeHeadersInto(target, { "X-Foo": "1" });
  mergeHeadersInto(target, { "x-foo": "2" }); // same header, different case -> override, not two entries
  assert.equal(target.get("X-Foo"), "2");
  assert.equal(Array.from(target.entries()).length, 1);
});

test("Group headers are inherited by Routes inside it; Route's own headers override on top", async () => {
  const tree = Router({
    children: Group({
      prefix: "/api",
      headers: { "X-Api-Version": "1", "X-Scope": "group" },
      children: Route({ path: "/x", method: "GET", headers: { "X-Scope": "route" }, children: ["x"] }),
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/api/x"));
  assert.equal(res.headers.get("X-Api-Version"), "1");
  assert.equal(res.headers.get("X-Scope"), "route");
});

test("Route headers override the response's own inferred Content-Type", async () => {
  const tree = Router({
    children: Route({ path: "/x", method: "GET", headers: { "Content-Type": "text/plain" }, children: ["x"] }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(res.headers.get("Content-Type"), "text/plain");
});

test("headers prop can be a function of the request", async () => {
  const tree = Router({
    children: Route({
      path: "/x",
      method: "GET",
      headers: (req: Request) => ({ "X-Method": req.method }),
      children: ["x"],
    }),
  });
  const compiled = await compile(tree);
  const res = await compiled.fetch(new Request("http://x/x"));
  assert.equal(res.headers.get("X-Method"), "GET");
});
