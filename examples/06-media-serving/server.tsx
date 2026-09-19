/**
 * `src`/`download` on <Route>: one mechanism behind video/audio/image/pdf/
 * download serving (range support on by default, ETag/If-None-Match,
 * Content-Disposition) -- deliberately not five media-specific tags. `src`
 * accepts a file path, an http(s):// URL, or (as here) an already-built
 * Blob -- Range/ETag/disposition behave identically either way.
 *
 * Run with:
 *   npm run build && node dist/examples/06-media-serving/server.js
 * Then:
 *   curl http://localhost:3005/sample.txt                              # full file
 *   curl -H "Range: bytes=0-9" http://localhost:3005/sample.txt -i      # 206 partial
 *   curl -i http://localhost:3005/sample-download.txt                  # Content-Disposition
 */
/** @jsxImportSource @johnhenry/servable */
import { Router, Route, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

const sample = new Blob(["This is a small text file being served with byte-range support.\n"], {
  type: "text/plain",
});

const app = (
  <Router>
    <Route path="/sample.txt" method="GET" src={sample} />
    <Route path="/sample-download.txt" method="GET" src={sample} download="renamed-on-download.txt" />
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3005 });
console.log("listening on http://localhost:3005");
