/**
 * Nested JSX from the very first example: fileable's `<Dir>`/`<File>`
 * written literally alongside servable's own `<Route>`s, under one
 * `@jsxImportSource @johnhenry/servable` pragma -- no `from=` indirection,
 * just direct containment (see examples/07-mount-fileable for the deeper
 * tour: multiple directories, index.html-at-directory-path, symlinks,
 * mounting without a folder name via a fileable Fragment, ...).
 *
 * Run with:
 *   npm run build && node dist/examples/01-hello-world/server.js
 * Then:
 *   curl http://localhost:3000/site/index.html
 *   curl http://localhost:3000/hello
 *   curl http://localhost:3000/users/42
 */
/** @jsxImportSource @johnhenry/servable */
import { Dir, File } from "@johnhenry/fileable";
import { Router, Route, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

const app = (
  <Router>
    <Dir name="site">
      <File name="index.html">{"<h1>Hello, world!</h1>"}</File>
    </Dir>
    <Route path="/hello" method="GET">
      Hello, world!
    </Route>
    <Route
      path="/users/:id"
      method="GET"
      handler={(req, ctx) => new Response(`user ${ctx.params.id}`)}
    />
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3000 });
console.log("listening on http://localhost:3000");
