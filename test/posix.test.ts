import { test } from "node:test";
import assert from "node:assert/strict";
import * as real from "node:path/posix";
import * as pure from "../src/posix.js";

// Verifies src/posix.ts (the browser-safe reimplementation used throughout
// servable's core instead of node:path/posix, see #5) is byte-for-byte
// identical to the real node:path/posix across a broad sample of inputs --
// not just the handful of cases this package's own callers happen to hit.
const samples = [
  "",
  ".",
  "..",
  "/",
  "//",
  "a",
  "a/b",
  "/a/b",
  "a/../b",
  "./a",
  "../a",
  "a/./b/../c",
  "a/b/",
  "/a/b/",
  "a.txt",
  ".hidden",
  "a.b.c",
  "a.",
  ".a",
  "index.html",
  "a//b",
  "a/b/../../c",
  "foo",
  "foo/bar",
  "/foo/bar/baz.js",
  "../..",
  "a/b/c/../../..",
  "a/b/c/../../../..",
  "x/y.z",
];

test("normalize() matches node:path/posix", () => {
  for (const s of samples) assert.equal(pure.normalize(s), real.normalize(s), s);
});

test("dirname() matches node:path/posix", () => {
  for (const s of samples) assert.equal(pure.dirname(s), real.dirname(s), s);
});

test("basename() matches node:path/posix", () => {
  for (const s of samples) assert.equal(pure.basename(s), real.basename(s), s);
});

test("extname() matches node:path/posix", () => {
  for (const s of samples) assert.equal(pure.extname(s), real.extname(s), s);
});

test("join() matches node:path/posix, including the '.' for all-empty-segments quirk", () => {
  for (const a of samples) {
    for (const b of samples) {
      assert.equal(pure.join(a, b), real.join(a, b), `join(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    }
  }
  assert.equal(pure.join("", ""), ".");
  assert.equal(pure.join(), ".");
});
