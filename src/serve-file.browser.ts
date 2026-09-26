/**
 * Browser-safe build of serve-file-core.ts's `serveFile`/`serveSrcProp` --
 * everything serve-file-core.ts already handles (Blob/File, `http(s)://`,
 * `ipfs://`) works unchanged here, since it's all standard Fetch-API
 * primitives. The one thing it can't do without `node:fs` -- reading a
 * plain string `src` as a local filesystem path -- throws a clear,
 * actionable `ServableError` instead of a bundler's empty `node:fs` stub
 * failing with an inscrutable "readFile is not a function".
 *
 * Resolved automatically via this package's `#serve-file` internal import
 * whenever a bundler/runtime resolves the `"browser"` condition (Vite,
 * webpack, esbuild with `conditions: ["browser"]`, ...) -- see package.json's
 * `imports` field and #5's writeup in CHANGELOG.md for the full split.
 */
import { ServableError } from "./types.js";
import { createServeFile } from "./serve-file-core.js";

export { inferContentType } from "./mime-types.js";
export type { ServeFileOptions } from "./serve-file-core.js";

const GUIDANCE =
  "this is @johnhenry/servable's browser-safe build (resolved via the \"browser\" export condition), which has no " +
  "access to a local filesystem -- pass a Blob/File, or an http(s):// or ipfs:// URL, for `src`/serveFile() " +
  "instead, or run under Node/a Node-targeting bundle, where local file paths work automatically.";

async function readLocalFile(source: string): Promise<never> {
  throw new ServableError(`local filesystem src "${source}" isn't available here -- ${GUIDANCE}`, source);
}

const { serveFile, serveSrcProp } = createServeFile({ readLocalFile });

export { serveFile, serveSrcProp };
