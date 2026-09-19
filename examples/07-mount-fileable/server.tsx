/**
 * `<Group from={fileableTree}>`: mounts a fileable Descriptor tree's
 * artifacts as static routes -- fileable describes the virtual filesystem,
 * servable serves it, with zero disk writes in between.
 *
 * Run with:
 *   npm run build && node dist/examples/07-mount-fileable/server.js
 * Then:
 *   curl http://localhost:3006/site/                    # index.html at the dir's own path
 *   curl http://localhost:3006/site/about/index.html
 */
/**
 * The fileable tree is built via plain function calls, not JSX -- fileable
 * and servable each declare their own nominal `Descriptor` type for their
 * own JSX runtime's type-checking, so `<Dir>`/`<File>` (fileable's JSX
 * tags) don't type-check as servable JSX elements in the same file even
 * though they work fine at runtime (mount-fileable.ts only ever duck-types
 * the shape). `Dir({...})`/`File({...})` sidesteps that entirely -- the
 * same "called directly as functions, no JSX needed" style fileable's own
 * docs already recommend.
 */
/** @jsxImportSource @johnhenry/servable */
import { Dir, File } from "@johnhenry/fileable";
import { Router, Group, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

const site = Dir({
  name: "dist",
  children: [
    File({
      name: "index.html",
      children: [`<!doctype html><html><body><h1>Home</h1><a href="/site/about/index.html">About</a></body></html>`],
    }),
    Dir({
      name: "about",
      children: [File({ name: "index.html", children: [`<!doctype html><html><body><h1>About</h1></body></html>`] })],
    }),
  ],
});

const app = (
  <Router>
    <Group prefix="/site" from={site} />
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3006 });
console.log("listening on http://localhost:3006");
