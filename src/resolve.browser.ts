/**
 * Browser-safe build of resolve-core.ts's Stage 2 walk. Everything
 * resolve-core.ts already handles (mounting a `<Group from={fileableTree}>`
 * or a directly-nested fileable descriptor, generic Promise-valued prop
 * resolution) works unchanged here -- it's all pure tree/string
 * manipulation. The two genuinely Node-only capabilities -- glob-expanding
 * a `<Group from="...">` pattern/file list and dynamically `import()`-ing
 * a matched handler file or a `<Route handler="./mod.js">` string path --
 * throw a clear, actionable `ServableError` instead of a bundler's empty
 * `node:path`/`node:url`/`glob` stubs failing with an inscrutable
 * "join is not a function".
 *
 * Resolved automatically via this package's `#resolve` internal import
 * whenever a bundler/runtime resolves the `"browser"` condition (Vite,
 * webpack, esbuild with `conditions: ["browser"]`, ...) -- see package.json's
 * `imports` field and #5's writeup in CHANGELOG.md for the full split.
 */
import { ServableError } from "./types.js";
import { createResolve } from "./resolve-core.js";

const GUIDANCE =
  "this is @johnhenry/servable's browser-safe build (resolved via the \"browser\" export condition), which has no " +
  "access to a local filesystem or dynamic import()-by-file-path -- both are genuinely Node-only. Build your route " +
  "tree from in-memory <Route handler={fn}> functions instead, or run compile() under Node/a Node-targeting bundle, " +
  "where file-based routing works automatically.";

export const resolve = createResolve({
  defaultBaseDir: () => "",

  async resolveGlobFrom(_fromValue, _baseDir, path) {
    throw new ServableError(`<Group from> (file-based routing) isn't available here -- ${GUIDANCE}`, path);
  },

  async resolveStringHandler(_handler, _baseDir, path) {
    throw new ServableError(`<Route handler="..."> (a string handler path) isn't available here -- ${GUIDANCE}`, path);
  },
});
