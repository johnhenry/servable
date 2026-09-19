/**
 * <Group from="glob"> file-based routing: one Route per named HTTP-method
 * export in each matched handler module (handlers/index.ts exports GET;
 * handlers/users/list.ts exports GET and POST), preserving subdirectory
 * structure.
 *
 * Run with:
 *   npm run build && node dist/examples/04-file-based-routing/server.js
 * Then:
 *   curl http://localhost:3003/api/index
 *   curl http://localhost:3003/api/users/list
 *   curl -X POST http://localhost:3003/api/users/list
 */
/** @jsxImportSource @johnhenry/servable */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Router, Group, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

// Absolute glob pattern computed from this (compiled) file's own location,
// so it resolves correctly regardless of which directory `node` is invoked
// from -- same default fileable's own CLI uses ("outDir defaults to the
// template file's own directory").
const here = dirname(fileURLToPath(import.meta.url));
const pattern = join(here, "handlers/**/*.js");

const app = (
  <Router>
    <Group prefix="/api" from={pattern} />
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3003 });
console.log("listening on http://localhost:3003");
