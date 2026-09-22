# Agent playbook

`@johnhenry/servable` — declaratively describe an HTTP server using JSX,
compiled into one Fetch-API `(Request) => Response` dispatcher. Single
package, Node >= 26, `node --test` via `scripts/run-tests.mjs` (`npm test`),
builds to `dist/` via `tsc` (`npm run build`). Most changes touch the
four-stage pipeline (`src/build.ts` -> `resolve.ts` -> `layout.ts` ->
`compile.ts`), a primitive's own file trio (`types.ts`/`components.ts`/
`jsx-runtime.ts`), or an adapter under `adapters/`.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm run build` — `tsc -p tsconfig.json`; compiles `src/`, `adapters/`,
   `test/`, and `examples/**/*.{ts,tsx}` together (examples are typechecked,
   not just src).
2. `npm test` — `pretest` reruns the build first, then
   `node --test scripts/run-tests.mjs`. No suite here is allowed to SKIP.
3. `npm pack --dry-run` — read the file list, not just the exit code.
4. A genuinely fresh clone:
   `git clone . /tmp/servable-verifyN && cd $_ && npm ci && npm run build && npm test`.
   This is the only way to catch "works on my checked-out tree" bugs
   (missing `files` entries, undeclared deps — `@johnhenry/fileable` and
   `@johnhenry/leserve` are both optional peer dependencies here; a fresh
   install without them must still pass the suites that don't exercise
   mounting/the Node adapter).
5. Run an example after building: `npm run build && node dist/examples/01-hello-world/server.js`,
   then hit it with `curl` per that example's own header comment.
6. Commit, push, close the issue with a comment naming the commit SHA.

CI (`.github/workflows/ci.yml`) runs build then test in that order; match it
locally.

## Repo-specific gotchas

- **`@johnhenry/fileable` and `leserve` are optional peer dependencies,
  lazily imported.** Mounting-support code (`from={fileableTree}`, the Node
  adapter) must not statically `import` either at module top-level — a
  routing-only consumer that never mounts a fileable tree or uses the Node
  adapter should never pay the cost of pulling either in.
- **The governing rule is the actual design constraint, not just prose:
  functions are always props, children are always a static value or nested
  primitives.** A new primitive whose "content" is a function belongs as a
  `handler`/`middleware`-shaped prop, never as JSX children — getting this
  backwards is exactly the shape of every rejected addition in the
  README's "Rejected additions" list.
- **New primitives are Layout-stage, almost always.** `Host` moved down
  from `hostable`'s own pre-Build rewrite into servable's Layout stage
  specifically because anything that runs *before* other stages finish
  expanding the tree (a mounted fileable tree, `Group from="glob"`,
  a promise-valued `path`) is invisible to an earlier-stage rewrite. See
  README's "Adding a new primitive" for the full worked example before
  adding another stage-ordering-sensitive primitive.
- **`URLPattern` needs the polyfill on older Node.** Not a global in Node
  18/20/22; `urlpattern-polyfill` is a real dependency, with the native
  global preferred when present. Don't assume `URLPattern` is always native
  in a test or example.

## Definition of done

A change is done when all of the following hold, not just when tests pass:

- A regression test exists for any bug fixed.
- Anything the feature does **not** do is stated in the README's
  "Non-goals" or the relevant section, not only in an issue comment.
- `CHANGELOG.md` has an entry citing the commit/PR.
- A new primitive follows README's "Adding a new primitive" checklist
  (`types.ts` union entry, `components.ts` factory, `jsx-runtime.ts`
  `RESERVED_TAGS` entry, the real Layout-stage logic) and, if it changes the
  "rejected additions" reasoning, that list is updated too.

## Non-goals

See README's "Non-goals": not a full HTTP server implementation, no
ORM/templating/sessions, no hot-reload, no plugin/middleware-registry
system beyond JSX composition, no built-in proxy or per-route timeout.

## Releases

Bump `version` in `package.json` in a PR, add the `CHANGELOG.md` entry, merge,
then `gh release create v<version>` — the release event triggers
`.github/workflows/publish.yml`, which is idempotent (skips if the version is
already on npm).
