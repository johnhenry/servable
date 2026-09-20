/**
 * Use/ErrorBoundary composition: containment decides scope, not sibling
 * order -- what's nested inside <Use> is what's protected.
 *
 * Run with:
 *   npm run build && node dist/examples/03-middleware-auth/server.js
 * Then:
 *   curl http://localhost:3002/public
 *   curl http://localhost:3002/admin/dashboard            # 401, no token
 *   curl -H "Authorization: Bearer secret" http://localhost:3002/admin/dashboard
 *   curl http://localhost:3002/admin/boom -H "Authorization: Bearer secret"
 */
/** @jsxImportSource @johnhenry/servable */
import { Router, Group, Route, Use, ErrorBoundary, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";
import type { Middleware } from "@johnhenry/servable";

const requireAuth: Middleware = async (req, ctx, next) => {
  if (req.headers.get("Authorization") !== "Bearer secret") {
    return new Response("unauthorized", { status: 401 });
  }
  return next();
};

const logTiming: Middleware = async (req, ctx, next) => {
  const start = Date.now();
  const res = await next();
  res.headers.set("X-Response-Time", `${Date.now() - start}ms`);
  return res;
};

const app = (
  <Router>
    <Route path="/public" method="GET">
      anyone can see this
    </Route>
    <Use middleware={logTiming}>
      <Group prefix="/admin">
        <Use middleware={requireAuth}>
          <Route path="/dashboard" method="GET">
            welcome, admin
          </Route>
          <ErrorBoundary handler={(error) => new Response(`admin error: ${(error as Error).message}`, { status: 500 })}>
            <Route
              path="/boom"
              method="GET"
              handler={() => {
                throw new Error("something broke");
              }}
            />
          </ErrorBoundary>
        </Use>
      </Group>
    </Use>
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3002 });
console.log("listening on http://localhost:3002");
