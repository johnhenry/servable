# Changelog

## Unreleased

### Added
- **EXAMPLE: `src="ipfs://<cid>/<path>"` on `Route`/`serveFile()`.** A
  second URI scheme `serve-file.ts`'s `resolveAsset()` recognizes, right
  alongside `https://` -- the same "one more branch" move
  `@johnhenry/fileable`'s own `loadSrc()` uses for the identical scheme,
  independently implemented here since `Route src` resolves fresh
  per-request (this package has no caching layer at all, by design) rather
  than once at compile time. New `CompileOptions.ipfsGateway`/
  `ServeFileOptions.ipfsGateway` (default `"https://ipfs.io/ipfs/"`),
  threaded from `compile(tree, options)` through `executeRoute()` down to
  `serveSrcProp()`/`serveFile()`/`resolveAsset()` -- the one part of this
  addition that isn't just a new `if` branch, since `Route src` resolution
  happens inside the per-request `dispatch()` closure, not during
  Build/Resolve/Layout. Verified for real, not just unit-level:
  `test/serve-file.test.ts` fetches through a real local HTTP server
  standing in for a gateway (Content-Type/ETag preserved from the real
  response, same as the existing `https://` handling), and a dedicated
  test proves the `ipfsGateway` option actually reaches a real
  `compile()`d `<Route src="ipfs://...">` end to end, not just
  `serveFile()` in isolation.
- **`Host name="..."` / `Host pattern="*.example.com"`** -- a real
  hostname-axis scope, handled in Layout (`layout.ts`) alongside `Group`'s
  own pathname-prefix scope: `WalkCtx.hostname` is threaded through the
  walk the same way `basePath` already is, baked into every nested
  `Route`/`Redirect`'s compiled `URLPattern`, and used for scope keying
  (`NotFound`/`ErrorBoundary`) and `linkTo()`. Previously this axis existed
  only in `@johnhenry/hostable`, implemented as a one-pass pre-Build tree
  rewrite -- which meant any route created by a LATER pipeline stage (a
  mounted fileable tree, `Group from="glob"` file-based routing, a
  promise-valued `path`, a literal `<Router>` nested inside a `<Host>`)
  was invisible to that rewrite and never got hostname-qualified at all,
  so it leaked across every `<Host>` in the gateway -- confirmed
  empirically: a `<Host>` that should only reverse-proxy elsewhere was
  also serving a sibling `<Host>`'s mounted static files. Moving `Host`
  into servable's own Layout stage (the stage that runs *after* every
  other stage has finished expanding the tree) fixes this at the root,
  for every expansion point at once, rather than requiring hostable to
  special-case each one as it's found. `@johnhenry/hostable` now
  re-exports this `Host` directly (same as `Group`/`Route`/etc.) instead
  of implementing its own; see hostable's own CHANGELOG for that side of
  the fix. See README's "The primitives" and `test/host.test.ts` for the
  full behavior and regression coverage (19 tests, including every one of
  the leak points enumerated above, each proven fixed against a real
  compiled app and real `fetch()` calls, not just reasoned about).
- **`Descriptor.tag`'s type widened from `StructuralTag | typeof FRAGMENT |
  string` to `StructuralTag | symbol | string`.** Enables writing a
  fileable tree as *literal* `<Dir>`/`<File>` JSX nested directly inside
  `<Router>`/`<Group>`, in the same file, under one
  `@jsxImportSource @johnhenry/servable` pragma -- both frameworks' `jsx()`
  already called function-typed tags directly at runtime, so this always
  worked correctly at runtime; only the type-checker rejected it, because
  fileable's own Fragment marker is a *different* `Symbol.for(...)` key
  than servable's, and the old type only recognized servable's exact one.
  See README's "Mounting without `from=`" for the full writeup and the
  equivalent `Dir({...})`/`{site}` function-call form (still supported,
  useful when the tree is built programmatically).

### Changed (breaking)
- **`Middleware`'s signature is now `(req, ctx, next)`, was `(req, next,
  ctx)`.** `ctx` moving next to `req` makes it a true prefix of every other
  handler shape in the family (`Route`'s `handler(req, ctx)`,
  `ErrorBoundary`'s `handler(error, req, ctx)`) instead of the one place in
  servable where `ctx` sat in a different position; `next` moving last also
  matches Express's own middleware convention. Any existing middleware
  written as `(req, next) => ...` needs updating to `(req, ctx, next) =>
  ...` -- the second positional argument is no longer the continuation
  function.

### Added
- **`examples/08-mount-packfile`**: composing a `packfile`-packaged
  directory into a servable tree needs no new servable primitive at all --
  `packfile`'s `createRouter()` already produces a `(Request | path, ctx?)
  => Response` handler, the exact shape `Route`'s `handler` prop already
  accepts. `Route path="/*"` inside a `Group prefix` captures the request's
  mount-relative path as `ctx.params["0"]` (`URLPattern`'s own
  wildcard-capture key) -- hand that straight to the router instead of the
  full request. `packfile` isn't published yet, so this is a devDependency
  on `file:../packfile` for now (CI checks it out as a sibling); switch to
  a real registry range once it's published, same as `leserve` did.
- **A fileable tree can now sit directly as a raw child of `<Router>`/
  `<Group>`, not just behind `from=`.** Both frameworks' JSX is sugar over
  plain `{tag,props,children}`-producing factory functions, so
  `Router({ children: [Dir({...}), Route({...})] })` was already legal
  JavaScript -- the gap was that Build/Resolve didn't recognize a raw
  fileable descriptor as anything other than an unrecognized servable
  node. Detection now uses `FILEABLE_DESCRIPTOR`, a
  `Symbol.for("fileable.descriptor")` global-registry brand
  `@johnhenry/fileable@0.0.1`+ stamps onto every descriptor it creates,
  replacing the old `{tag,props,children}`-shape duck typing (which was
  only ever safe because it was called exclusively on `from=`'s value --
  every servable descriptor has that identical shape too, so it couldn't
  tell them apart once a fileable node might appear anywhere a servable
  node could). This revises the governing rule: children are now a static
  value, nested servable primitives, *or* a fileable tree -- scoped to
  `Router`/`Group` specifically, not `Route`'s children (a different,
  static-value slot).

### Fixed
- `compile()`'s pre-Build tree clone (`cloneDescriptorTree`) reconstructed
  every descriptor-shaped value field by field, which silently stripped
  the `FILEABLE_DESCRIPTOR` brand (a plain object literal has no reason to
  carry an unrelated package's symbol-keyed property) -- meaning a second
  `compile()` call on the same tree would fail to recognize a fileable
  tree the first call had correctly mounted. A fileable-branded value is
  now treated as opaque and cloned by reference, same as any other opaque
  prop value (`Blob`, `Request`, a function).
- The dev dependency on `leserve` pointed at a local `file:../leserve`
  path, which can't resolve for anyone outside this machine. `leserve`
  was adopted into the `@johnhenry` scope and published for real; the
  peer/dev dependencies here now point at the real `@johnhenry/leserve`.
- **`mount-fileable.ts` still spoke fileable's old vocabulary** --
  `target: "loose" | "archive"` and an `as="archive"` skip-check, both
  stale after fileable's own container-target values were renamed twice
  (`"archive"`/`"packfile"` -> `"zip"`/`"wbn"`, then the `Dir` prop itself
  from `as` to `encode`). Not a live bug against the *published*
  `@johnhenry/fileable@0.0.1` this package currently depends on (which
  predates all of those renames), but a real, silent one waiting to
  trigger the moment fileable ships them: the target check would simply
  never match `"zip"`/`"wbn"`, so every file inside a `<Dir encode="zip">`
  or `<Dir encode="wbn">` subtree would fall through and get mounted as an
  individual loose route instead of being skipped-with-a-warning the way
  an unmountable container is supposed to be. Updated the check to cover
  both `"zip"` and `"wbn"` (previously only one container format existed
  at all), the local `FileableArtifact` type's stale `archivePath` field
  to fileable's real `containerPath`, and every doc comment. Verified
  against fileable's actual current API, not just read for consistency:
  the dev dependency here was pointed at `file:../fileable` (matching this
  family's established pattern for actively-co-developed siblings) to run
  two new real tests (`test/mount-fileable.test.ts`) proving a `"zip"`
  and a `"wbn"` subtree are each correctly skipped, with the expected
  warning, rather than silently mismounted.

### Changed
- `adapters/node`'s `serve()` now delegates to
  [`leserve`](https://github.com/johnhenry/leserve)'s own `serve()`
  instead of maintaining a second, independently-drifting Node HTTP
  bridge -- same "prefer an existing, more mature implementation" reflex
  this design already applied to `Request`/`Response`/`Headers`/
  `URLPattern`. `leserve` is an optional peer dependency, only needed if
  you use this adapter. The returned handle's shape changed to match
  leserve's own (`{ finished, [Symbol.asyncDispose]() }` instead of a
  raw `node:http` `Server`) -- read the listening port via the new
  `onListen` option instead of `server.address()`, and dispose via
  `await handle[Symbol.asyncDispose]()` instead of `server.close()`.

### Added
- `upgradeWebSocket()`'s Node branch is now real (was: throws a clear
  "no implementation" error). Delegates to `leserve`'s
  `upgradeRawSocket()`, reached via `req.raw` -- the raw `IncomingMessage`
  `leserve`'s `serve()` already attaches to every `Request` it
  constructs. Verified with a real client `WebSocket` round-trip test
  against the real Node adapter, not just a unit test.
- Trailers (`trailers` prop / `Route`'s `headers`-adjacent mechanism) are
  now actually transmitted on Node, via `leserve`'s new `setTrailers()` --
  previously computed and validated but never wired to a real
  `res.addTrailers()` call.

### Fixed
- `compile.ts` assumed every route handler's return value was a real
  `Response` (accessing `.headers` unconditionally) -- a completed
  WebSocket upgrade can't be one (the Fetch spec's `Response` constructor
  rejects status 101), so returning `upgradeWebSocket()`'s response from
  a route crashed on header-merging. Now recognized purely by
  `.status === 101` and passed through untouched.

## 0.0.0

Initial release. servable is `fileable`'s sibling: the same technique (own
JSX runtime, a small closed primitive set, fail-loudly-on-ambiguity
discipline) applied to a different domain -- describing an HTTP server
instead of a filesystem, compiled into one Fetch-API `(Request) => Response`
dispatcher.

**Why it looks the way it does:** every primitive/prop shape here was
reached by pressure-testing the design turn by turn against a single
governing rule -- functions are always props, children are always either a
static value or nested primitives, containment decides scope, never
sibling order -- and by preferring a standard Web Platform type (`Request`,
`Response`, `Headers`, `URLPattern`) over inventing a parallel one whenever
one already exists.

### Added
- Eight primitives: `Router`, `Group` (`prefix`, `from` -- glob for
  file-based routing, or a fileable tree to mount), `Route` (`path`,
  `method`, `handler`, `src`, `download`, polymorphic static children),
  `Use`, `ErrorBoundary`, `NotFound`, `Redirect`, `Response`.
- A four-stage pipeline (Build -> Resolve -> Layout -> Compile), each stage
  independently exported, same PRD-derived framing as fileable's own
  five-stage pipeline (Hash has no equivalent here -- there's no
  "unchanged, skip" concept for live code).
- `URLPattern`-based path matching (`urlpattern-polyfill` for Node
  18/20/22, preferring a native global when present), including `path="/"`
  inside a `Group` matching both with and without a trailing slash.
- Onion-style `Use` composition and nearest-ancestor `ErrorBoundary`/
  `NotFound` resolution, both built from tree containment, never sibling
  position.
- `headers`/`trailers` merged through a real `Headers` instance (case-
  insensitive override, `Set-Cookie` accumulation) -- never naive
  object-spread.
- `src`/`download` on `Route`, and the standalone `serveFile()` helper:
  Range support on by default (206, `Accept-Ranges`, `Content-Range`, via
  `Blob.prototype.slice()`), conditional requests (`ETag`/`If-None-Match`),
  correct `HEAD` handling, `Content-Disposition`. One mechanism behind
  video/audio/image/pdf/download serving, deliberately not five
  media-specific tags.
- Runtime API: `linkTo()`, `warn()`, `markdownToHtml()`, `setCookie()`,
  `sse()`, `streamBody()`, `upgradeWebSocket()` (real support: Deno,
  Cloudflare Workers -- Node has no server-side WebSocket upgrade/framing
  at all, and implementing that correctly from a raw socket is real
  protocol work outside this release's scope; throws a clear error on
  Node rather than shipping an unverified bridge).
- Adapters: `adapters/node` (the real engineering work -- bridges
  `node:http`'s `IncomingMessage`/`ServerResponse` to/from `Request`/
  `Response`, including best-effort trailers via `res.addTrailers()`),
  `adapters/deno`, `adapters/bun`, `adapters/cloudflare` (all three thin
  pass-throughs, since those runtimes already speak the Fetch
  `(Request) => Response` signature natively).
- Mounting a fileable tree (`<Group from={fileableTree}>`): runs fileable's
  own exported `build`/`resolve`/`layout` stages to get a real artifact
  list (byte-exact content, binary-safety already solved), maps each to a
  static `Route`. `@johnhenry/fileable` is an optional peer dependency,
  lazily imported only when actually used. A directory's `index.html` also
  serves at the directory's own path; a fileable `symlink` artifact becomes
  a `Redirect`; an `as="archive"` artifact isn't mounted yet (fileable's
  zip assembly isn't part of its public API -- skipped with a warning); a
  `Rm` node has nothing to serve (skipped with a warning).
- 82 tests: pipeline stages, middleware/error-boundary/not-found
  composition (with an explicit regression guard against reintroducing
  `Use`'s rejected position-sensitivity), headers merging, static-content
  resolution for every recognized value type, `URLPattern` matching,
  `serveFile()`'s Range/conditional-request/download logic, file-based
  routing, mounting a fileable tree (including a real byte-exact PNG round
  trip), and a real HTTP round-trip suite against the Node adapter
  (including a ranged request against a real file and SSE/stream
  consumption to completion).

### Fixed (found by actually running the design against real requests, not just reading it)
- `compile()` mutated the tree in place (same class of bug fileable's own
  `render()` had) -- fixed by cloning once at the top, before Build ever
  touches it, so calling `compile()` twice on the same tree object never
  leaks one call's mutations into the next.
- A plain-object (or other `BodyInit`-shaped) child was being coerced to a
  string by Build's fileable-inherited "anything else is probably a
  mistake" fallback -- correct for fileable (content must eventually be
  textual/binary) but wrong here, where an object is a legitimate JSON-body
  value. Fixed by widening `DescriptorChild` and only rejecting the cases
  that really are mistakes (a bare `Promise` or function as content).
- `<Group from="glob">`'s subdirectory-preserving path computation silently
  collapsed to a bare basename whenever the glob pattern itself was passed
  as an absolute path (mixing an absolute pattern-base against a
  match's relative-to-cwd representation broke a `startsWith` check) --
  found by testing file-based routing with an absolute pattern, not just a
  relative one. Fixed by resolving the pattern's own base to an absolute
  path up front and computing each match relative to *that*, instead of
  string-prefix-matching two representations that don't share a basis.
- A `NotFound`-less scope fell straight to the generic 404 instead of
  bubbling out to the nearest ancestor's own `NotFound` -- fixed to match
  `ErrorBoundary`'s already-correct nearest-ancestor pattern.
- `<Redirect>`'s `to` wasn't Group-relative (only `from` was), which broke
  fileable-tree-mounted symlink redirects (computed relative to the mount
  root, needing the Group's own prefix applied on top) and was
  inconsistent with everything else in a scope being scope-relative by
  default. Fixed, with an absolute `http(s)://` `to` correctly left alone.
- `path="/"` inside a `Group` compiled to a route requiring a trailing
  slash (`posixPath.join("/users", "/")` produces `/users/`), which
  wouldn't match a plain `GET /users` request -- the form real REST APIs
  and static-directory serving both expect to work. Fixed via `URLPattern`'s
  own optional-group syntax (`{/}?`) so both forms match, while the
  *canonical* path used for `linkTo()`/dedup stays the clean, no-slash form.
