import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/build.js";
import { FRAGMENT, ServableError } from "../src/types.js";
import type { Descriptor } from "../src/types.js";

function route(path: string, children: unknown[] = []): Descriptor {
  return { tag: "route", props: { path }, children: children as never };
}

test("flattens fragments into the parent's children", () => {
  const fragment: Descriptor = { tag: FRAGMENT, props: {}, children: [route("/a"), route("/b")] };
  const [root] = build({ tag: "router", props: {}, children: [fragment] });
  assert.equal(root.children.length, 2);
});

test("flattens nested arrays from .map()", () => {
  const nested = [route("/a"), [route("/b"), [route("/c")]]];
  const [root] = build({ tag: "router", props: {}, children: nested });
  assert.equal(root.children.length, 3);
});

test("drops null/undefined/boolean children", () => {
  const [root] = build({ tag: "router", props: {}, children: [null, undefined, false, true, route("/a")] });
  assert.equal(root.children.length, 1);
});

test("coerces number children to strings", () => {
  const [root] = build({ tag: "route", props: { path: "/a" }, children: [1, 2, 3] });
  assert.deepEqual(root.children, ["1", "2", "3"]);
});

test("passes a plain object child through unchanged (a legitimate JSON body value here, unlike fileable)", () => {
  const [root] = build({ tag: "route", props: { path: "/a" }, children: [{ ok: true }] });
  assert.deepEqual(root.children, [{ ok: true }]);
});

test("a Promise as JSX content throws instead of silently stringifying", () => {
  assert.throws(
    () => build({ tag: "route", props: { path: "/a" }, children: [Promise.resolve("later")] }),
    ServableError,
  );
});

test("a bare function as JSX content throws -- handlers go through the `handler` prop, not content", () => {
  assert.throws(
    () => build({ tag: "route", props: { path: "/a" }, children: [() => new Response("x")] }),
    ServableError,
  );
});

test("assigns a stable __id to every descriptor", () => {
  const [root] = build({ tag: "router", props: {}, children: [route("/a")] });
  assert.ok(root.__id);
  const child = root.children[0] as Descriptor;
  assert.ok(child.__id);
  assert.notEqual(root.__id, child.__id);
});
