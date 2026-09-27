import { test } from "node:test";
import assert from "node:assert/strict";
import { Dir, File } from "@johnhenry/fileable";
// Deliberately imported from the package's own public entry point
// (src/index.ts, compiled to the exact file package.json's "main"/
// "exports" point at) -- issue #9 is specifically about the *public*
// contract of calling these pipeline stages independently, and
// cloneDescriptorTree (the issue's second, smaller ask) needs to be
// reachable from here too, not just internally.
import { build, resolve, compile, cloneDescriptorTree } from "../src/index.js";
import { Group, Router } from "../src/components.js";
import type { Descriptor } from "../src/types.js";

/** A tree whose fileable mount produces exactly one warning (an `encode="zip"` subtree, skipped rather than mounted -- see mount-fileable.ts). */
function treeWithOneWarning(): Descriptor {
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
  return Router({ children: Group({ prefix: "/static", from: site }) });
}

test("resolve()'s own return value carries exactly that call's warnings, via .warnings", async () => {
  const built = build(treeWithOneWarning());
  const resolved = await resolve(built, {});
  assert.equal(resolved.warnings.length, 1);
  assert.ok(resolved.warnings[0].includes('encode="zip"'));
  assert.ok(resolved.warnings[0].includes('"a.txt"'));

  // A second, wholly independent resolve() call (fresh build(), no shared
  // state) reports its own single warning too -- not accumulated on top of
  // the first call's.
  const builtAgain = build(treeWithOneWarning());
  const resolvedAgain = await resolve(builtAgain, {});
  assert.equal(resolvedAgain.warnings.length, 1);
});

test(
  "calling resolve() directly, repeatedly, before compile() does not leak warnings into that later, unrelated compile() call (issue #9)",
  async () => {
    // Call resolve() standalone several times BEFORE ever calling compile().
    // Each call mounts a fresh tree with exactly one skipped-artifact
    // warning. Before the fix, mount-fileable.ts pushed this warning into
    // context.ts's module-global accumulator, which only compile() ever
    // cleared -- so these standalone calls would silently pile up warnings
    // there, and the next, wholly unrelated compile() call would report
    // them AGAIN on top of its own (e.g. 4 warnings instead of 1, here).
    for (let i = 0; i < 3; i++) {
      const built = build(treeWithOneWarning());
      await resolve(built, {});
    }

    const compiled = await compile(treeWithOneWarning());
    assert.equal(
      compiled.warnings.length,
      1,
      `compile()'s warnings should be exactly its own single warning, not inflated by the 3 earlier ` +
        `standalone resolve() calls (got ${JSON.stringify(compiled.warnings)})`,
    );
    assert.ok(compiled.warnings[0].includes('encode="zip"'));
    assert.ok(compiled.warnings[0].includes('"a.txt"'));

    // Compiling again, fresh, right after -- still exactly 1, not 2.
    const compiledAgain = await compile(treeWithOneWarning());
    assert.equal(compiledAgain.warnings.length, 1);
  },
);

test("cloneDescriptorTree is exported from the package's public entry point and clones without mutating the original", () => {
  const original = Router({ children: [Group({ prefix: "/api", children: [] })] });
  const clone = cloneDescriptorTree(original);

  assert.notEqual(clone, original, "clone must be a different object identity");
  assert.deepEqual(clone, original, "clone must be structurally equal to the original");

  // Mutating the clone's props/children must never reach back into the
  // original -- the whole point of a caller inspecting a tree "without
  // mutating it" (issue #9's second ask).
  const cloneGroup = clone.children[0] as Descriptor;
  const originalGroup = original.children[0] as Descriptor;
  cloneGroup.props.prefix = "/mutated";
  cloneGroup.children.push("extra" as never);

  assert.equal(originalGroup.props.prefix, "/api");
  assert.equal(originalGroup.children.length, 0);
});
