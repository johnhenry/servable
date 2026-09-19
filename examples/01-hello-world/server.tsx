/**
 * Run with:
 *   npm run build && node dist/examples/01-hello-world/server.js
 * Then:
 *   curl http://localhost:3000/hello
 *   curl http://localhost:3000/users/42
 */
/** @jsxImportSource @johnhenry/servable */
import { Router, Route, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

const app = (
  <Router>
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
