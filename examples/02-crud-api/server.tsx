/**
 * Static + dynamic Route mix, and <Response> for a fully declarative
 * non-200 status without writing a handler function.
 *
 * Run with:
 *   npm run build && node dist/examples/02-crud-api/server.js
 * Then:
 *   curl http://localhost:3001/users
 *   curl -X POST http://localhost:3001/users
 *   curl http://localhost:3001/users/7
 */
/**
 * Note the aliased import: `Response` (the JSX tag) shadows the global
 * Fetch API `Response` class if imported under its own name -- this file
 * constructs real Response instances too (`Response.json(...)`), so the
 * tag is imported as `ResponseTag` to keep both available. Alias it
 * whenever a file needs both.
 */
/** @jsxImportSource @johnhenry/servable */
import { Router, Group, Route, Response as ResponseTag, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

interface User {
  id: string;
  name: string;
}

const users: User[] = [{ id: "1", name: "Ada" }, { id: "7", name: "Grace" }];

const app = (
  <Router>
    <Group prefix="/users">
      {/* A bare array as children flattens (same as any multi-child JSX
          position) rather than serializing as one JSON array -- a handler
          returning Response.json(...) is the unambiguous way to serve a
          list. */}
      <Route path="/" method="GET" handler={() => Response.json(users)} />
      <Route path="/" method="POST">
        <ResponseTag status={201} headers={{ Location: "/users/new" }}>
          {{ id: "new", name: "unnamed" }}
        </ResponseTag>
      </Route>
      <Route
        path="/:id"
        method="GET"
        handler={(req, ctx) => {
          const user = users.find((u) => u.id === ctx.params.id);
          if (!user) return new Response("not found", { status: 404 });
          return Response.json(user);
        }}
      />
    </Group>
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3001 });
console.log("listening on http://localhost:3001");
