/**
 * An app for the `servable serve` CLI: the module only default-exports the
 * compiled app and never calls `serve()` itself -- the CLI owns the port,
 * the lifecycle and (with --json) the event stream.
 *
 * Run with:
 *   npm run build && node dist/src/cli.js serve dist/examples/09-serve-cli/app.js --port 3008
 * Machine-driven (a free port, NDJSON events, reload on change, under
 * Node's permission model):
 *   node --permission --allow-fs-read="$PWD" --allow-net dist/src/cli.js \
 *     serve dist/examples/09-serve-cli/app.js --port 0 --json --watch
 * Then:
 *   curl http://127.0.0.1:3008/hello
 *   curl http://127.0.0.1:3008/whoami -H "X-Forwarded-Host: app.localhost"   # with --trust-proxy
 */
/** @jsxImportSource @johnhenry/servable */
import { Router, Route, compile } from "@johnhenry/servable";

export default await compile(
  <Router>
    <Route path="/hello" method="GET">
      Hello from servable serve!
    </Route>
    <Route path="/whoami" method="GET" handler={(req) => new Response(`${new URL(req.url).origin}\n`)} />
  </Router>,
);
