/**
 * sse()/streamBody(): both already fully expressible via `handler`
 * returning a real Response with a ReadableStream body -- these are just
 * ergonomics around building that value, not a new kind of Route content.
 *
 * Run with:
 *   npm run build && node dist/examples/05-streaming/server.js
 * Then:
 *   curl http://localhost:3004/events        # watch three ticks arrive live
 *   curl http://localhost:3004/download       # a plain streamed body
 */
/** @jsxImportSource @johnhenry/servable */
import { Router, Route, compile, sse, streamBody } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

async function* ticks() {
  for (let i = 1; i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 300));
    yield { data: `tick ${i}`, id: String(i) };
  }
}

async function* chunks() {
  yield "first chunk, ";
  await new Promise((r) => setTimeout(r, 100));
  yield "second chunk";
}

const app = (
  <Router>
    <Route path="/events" method="GET" handler={() => sse(ticks())} />
    <Route path="/download" method="GET" handler={() => streamBody(chunks(), { headers: { "Content-Type": "text/plain" } })} />
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3004 });
console.log("listening on http://localhost:3004");
