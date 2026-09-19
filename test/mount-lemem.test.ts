/**
 * `lemem`'s `createRouter()` composes directly with `Route`'s `handler`
 * prop -- no new servable primitive/module needed, unlike fileable (a
 * *description* servable has to walk and map to routes). This is a
 * regression guard for that composition contract, not a new integration
 * surface: mainly, that `ctx.params["0"]` (URLPattern's wildcard-capture
 * key) is really what a `Group prefix`-mounted `Route path="/*"` hands
 * you, and that it's really what lemem's router expects as a bare path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromDirectory, createRouter } from "lemem";
import { compile } from "../src/compile.js";
import { Group, Route, Router } from "../src/components.js";

async function withSite(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "servable-mount-lemem-"));
  try {
    await writeFile(join(root, "index.html"), "home");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "index.html"), "docs home");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a lemem router mounted via Route's handler prop serves the packaged directory", async () => {
  await withSite(async (root) => {
    const files = await fromDirectory(root);
    const router = createRouter(files, { tryExtensions: [".html"], alias: { "": "index.html" } });
    const tree = Router({
      children: Group({
        prefix: "/mem",
        children: Route({ path: "/*", method: "GET", handler: (req, ctx) => router((ctx.params as Record<string, string>)["0"] ?? "") }),
      }),
    });
    const compiled = await compile(tree);

    const root_ = await compiled.fetch(new Request("http://x/mem/"));
    assert.equal(await root_.text(), "home");

    const nested = await compiled.fetch(new Request("http://x/mem/docs/index.html"));
    assert.equal(await nested.text(), "docs home");

    const missing = await compiled.fetch(new Request("http://x/mem/nope.html"));
    assert.equal(missing.status, 404);
  });
});

test("the mount composes with an explicit sibling Route in the same Group", async () => {
  await withSite(async (root) => {
    const files = await fromDirectory(root);
    const router = createRouter(files, { tryExtensions: [".html"], alias: { "": "index.html" } });
    const tree = Router({
      children: Group({
        prefix: "/mem",
        children: [
          Route({ path: "/api", method: "GET", children: [{ ok: true }] }),
          Route({ path: "/*", method: "GET", handler: (req, ctx) => router((ctx.params as Record<string, string>)["0"] ?? "") }),
        ],
      }),
    });
    const compiled = await compile(tree);

    const api = await compiled.fetch(new Request("http://x/mem/api"));
    assert.deepEqual(await api.json(), { ok: true });

    const site = await compiled.fetch(new Request("http://x/mem/"));
    assert.equal(await site.text(), "home");
  });
});
