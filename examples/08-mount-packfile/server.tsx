/**
 * Serving a `packfile`-packaged directory through servable -- no new servable
 * primitive needed. `packfile`'s `createRouter()` already produces a
 * `(Request | path, ctx?) => Response` handler (it even aliases itself as
 * `.fetch`), the exact shape `Route`'s `handler` prop already accepts.
 * Unlike `@johnhenry/fileable` (a *description* of a filesystem, mounted
 * via `mount-fileable.ts` because there's a real Descriptor tree to walk
 * and map to routes), a `packfile` archive is already a live, Fetch-shaped
 * server -- composing it in is just passing a function, not a new
 * integration surface.
 *
 * The one piece of glue: `Route path="/*"` inside `Group prefix="/mem"`
 * captures the request's path *relative to the mount point* as
 * `ctx.params["0"]` (URLPattern's own wildcard-capture key) -- hand that
 * straight to the router instead of the full request, whose `/mem` prefix
 * packfile's own file map knows nothing about. `alias: { "": "index.html" }`
 * (packfile's path-after-alias is always leading-slash-stripped, so this is
 * keyed by "", not "/") makes the mount root itself serve its own index,
 * matching fileable-mount's directory-index-at-own-path behavior.
 *
 * Run with:
 *   npm run build && node dist/examples/08-mount-packfile/server.js
 * Then:
 *   curl http://localhost:3007/mem/
 *   curl http://localhost:3007/mem/docs/index.html
 */
/** @jsxImportSource @johnhenry/servable */
import { fromDirectory, createRouter } from "@johnhenry/packfile";
import { Router, Group, Route, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";
import { join } from "node:path";

// "site/" is plain HTML, not TypeScript -- tsc's build doesn't copy it into
// dist/, so it's addressed relative to the package root (where `npm run
// build && node dist/examples/08-mount-packfile/server.js` is always run from,
// per the doc comment above), not the compiled file's own location.
const files = await fromDirectory(join(process.cwd(), "examples/08-mount-packfile/site"));
const router = createRouter(files, {
  tryExtensions: [".html"],
  alias: { "": "index.html" },
});

const app = (
  <Router>
    <Group prefix="/mem">
      <Route path="/*" method="GET" handler={(req, ctx) => router(ctx.params["0"] ?? "")} />
    </Group>
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3007 });
console.log("listening on http://localhost:3007");
