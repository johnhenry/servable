# servable

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fservable.svg)](https://www.npmjs.com/package/@johnhenry/servable)
[![CI](https://github.com/johnhenry/servable/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/servable/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fservable.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/servable](https://opensource.johnhenry.me/servable/)

Declaratively describe an HTTP server using JSX -- a small closed set of
primitives, driven by servable's own JSX runtime (no React/Solid/Astro
dependency), compiled into one Fetch-API `(Request) => Response` dispatcher.

servable is `fileable`'s sibling: same technique (own JSX runtime, a small
closed primitive set, fail-loudly-on-ambiguity discipline), different
domain -- a live HTTP dispatcher instead of a filesystem tree. They're
deliberately separate packages, not a shared dependency; `fileable` stays a
filesystem tool, servable stays a routing tool. servable can optionally
*mount* a fileable tree as static routes (see below) -- that's the one
place they meet.

## Contents

- [The governing rule](#the-governing-rule)
- [Installation](#installation)
- [Quick example](#quick-example)
- [The primitives](#the-primitives)
- [Adding a new primitive](#adding-a-new-primitive)
- [Standard Web API usage](#standard-web-api-usage)
- [Headers and trailers](#headers-and-trailers)
- [Streaming](#streaming)
- [Mounting a fileable tree](#mounting-a-fileable-tree)
  - [Mounting without `from=`](#mounting-without-from)
  - [Mounting a single bare `<File>` (no `<Dir>` needed)](#mounting-a-single-bare-file-no-dir-needed)
  - [Fileable descriptors are only recognized under `<Router>`/`<Group>`](#fileable-descriptors-are-only-recognized-under-routergroup)
- [Adapters](#adapters)
  - [Browser and edge bundling](#browser-and-edge-bundling)
- [Command line](#command-line)
  - [Events (`--json`)](#events---json)
  - [Error and exit codes](#error-and-exit-codes)
  - [Lifecycle](#lifecycle)
  - [Behind a proxy](#behind-a-proxy)
  - [Node's permission model](#nodes-permission-model)
- [Non-goals](#non-goals)
- [Examples](#examples)
- [Family](#family)
- [License](#license)

## The governing rule

> **Functions are always props. Children are always either a static value
> or nested primitives. Containment decides scope, never sibling order.**

This is why `Use`/`ErrorBoundary` wrap a subtree (children = what's
affected) instead of being declared as siblings with "applies to whatever
comes after it" semantics, and why a `Route`'s handler is a `handler` prop,
not its children -- a function is a *mechanism that produces a value per
request*, the same role `src`/`cmd` play in fileable, not literal content.

## Installation

```sh
npm install @johnhenry/servable
```

## Quick example

```tsx
/** @jsxImportSource @johnhenry/servable */
import { Router, Route, compile } from "@johnhenry/servable";
import { serve } from "@johnhenry/servable/adapters/node";

const app = (
  <Router>
    <Route path="/hello" method="GET">Hello, world!</Route>
    <Route path="/users/:id" method="GET" handler={(req, ctx) => new Response(`user ${ctx.params.id}`)} />
  </Router>
);

const compiled = await compile(app);
serve(compiled, { port: 3000 });
```

`compile()` runs the same four-stage pipeline every time: Build (normalize
the tree) -> Resolve (import `handler="./mod.js"` module paths, expand
`<Group from>`) -> Layout (assign method+path, build each route's
middleware chain) -> Compile (produce the dispatcher). The result is a
`{ fetch, warnings }` object; `fetch` is a plain `(Request) => Promise<Response>`,
usable directly (Deno, Bun, Cloudflare Workers all accept this signature
natively) or through an adapter (Node needs one -- see below).

## The primitives

- **`Router`** -- root container.
- **`Host name="..."` or `Host pattern="*.example.com"`** -- a hostname-axis
  scope, matched against the incoming request's own Host header. Compiles
  into the same `URLPattern` `hostname` component every nested `Route`'s
  own compiled pattern carries -- a real Layout-stage scope (applied
  *after* every other pipeline stage has finished expanding the tree:
  mounted fileable trees, glob-based file routing, promise-valued `path`s,
  ...), the same stage `Group`'s own prefix-joining, `NotFound`/
  `ErrorBoundary` scoping, and `linkTo()` already live in. `name` and
  `pattern` are mutually exclusive; exactly one is required. Composes with
  `Group` in either nesting order -- the hostname and pathname axes are
  independent. Cannot be nested inside another `Host`. A `Route`/`Redirect`
  with no `Host` ancestor matches any hostname, unchanged from before
  `Host` existed.
- **`Group prefix="..." from="glob"|fileableTree`** -- a path-prefix scope;
  nesting concatenates prefixes, same way nested `Dir`s concatenate names
  in fileable. `from` is polymorphic:
  - a glob string synthesizes one `Route` per matched handler module
    (file-based routing) -- named exports matching an HTTP method
    (`export function GET(req) {...}`) become one route each; a plain
    `export default` becomes a single `GET` route. Subdirectory structure
    is preserved (`handlers/users/list.js` -> `/users/list`, not flattened).
  - a **fileable Descriptor tree** mounts its artifacts as static routes --
    see "Mounting a fileable tree", below.
- **`Route path="..." method="GET" handler={fn|"./mod.js"} src={...} download={...}`**
  -- a leaf. `path` is a string (compiled to a `URLPattern` internally,
  `:id`-style named params) or a real `URLPattern` instance for advanced
  matching (cross-origin, query-string patterns). At most one of
  `handler`/`src`/children may be set -- mixing throws.
  - **`handler`** -- a function `(req, ctx) => Response | Promise<Response>`,
    or an import path string whose module's default export is the handler.
  - **`src`** -- a binary/static asset: a local file path, an `http(s)://`
    URL, an `ipfs://<cid>/<path>` URI (EXAMPLE -- fetched via a
    configurable gateway, `compile()`'s `ipfsGateway` option, default
    `"https://ipfs.io/ipfs/"`; the same scheme `@johnhenry/fileable`'s own
    `<File src>` recognizes, independently implemented here since `Route
    src` resolves fresh per request rather than once at compile time), an
    already-built `Blob`, or a function of the request returning one of
    those. Gets Range support **on by default** (206 Partial Content,
    `Accept-Ranges`, `Content-Range`, via `Blob.prototype.slice()`),
    conditional requests (`ETag`/`If-None-Match` -> 304), and correct `HEAD`
    handling. `download` (boolean or a filename string) sets
    `Content-Disposition: attachment`. This is the *one* mechanism behind
    video/audio/image/pdf/download serving -- deliberately not five
    media-specific tags, the same restraint fileable's `<File src>` already
    applies to binary content generally. The same logic is available as a
    standalone `serveFile(req, source, options)` helper for handlers that
    need logic around it (auth-gated files, a computed path) --
    `options.ipfsGateway` works there too.
  - **children** (a static value only, never a function): a string (->
    `text/plain`), JSX markup (-> serialized HTML, `text/html`), a plain
    object (-> `Response.json`), a recognized `BodyInit` (`Blob`,
    `ArrayBuffer`/typed array, `FormData`, `URLSearchParams`,
    `ReadableStream` -- handed straight to `new Response()`, which already
    infers the right `Content-Type`), or a real `Response` (passed through
    untouched). A bare *array* as children flattens like any multi-child
    JSX position rather than serializing as one JSON array -- use
    `handler={() => Response.json(arr)}` for a list.
- **`Use middleware={fn}>{children}</Use>`** -- wraps a subtree. Signature
  `(req, ctx, next) => Response | Promise<Response>` -- `(req, ctx)` matches
  every other handler shape in the family (`Route`'s `handler`,
  `ErrorBoundary`'s `handler`), with `next` appended last; not calling
  `next()` is the short-circuit (no special ceremony). Composition is **onion-style**
  -- outermost runs first going in, last coming out, and since handlers are
  Fetch-shaped (no mutable `res`), a middleware can still inspect/modify
  the final `Response` after `await next()` resolves.
- **`ErrorBoundary handler={fn}>{children}</ErrorBoundary>`** -- wraps a
  subtree; catches any throw from middleware or handlers inside it.
  Deliberately named/scoped like React's error boundaries: nearest
  enclosing boundary catches, an uncaught (or re-thrown) error propagates
  to the next one out.
- **`NotFound handler={fn}` or `<NotFound>static</NotFound>`** -- fallback,
  scoped by its `Group`/`Router`. Nearest-scope-wins: a scope with no
  `NotFound` of its own bubbles out to the next ancestor's, same pattern as
  `ErrorBoundary` -- one scoping rule for the whole system, not two. The
  owning scope's own `Use`/`ErrorBoundary` chain wraps its `NotFound` too.
- **`Redirect from="..." to="..." status={301}`** -- leaf, self-closing.
  Both `from` and `to` are Group-relative (like everything else in a
  scope), except an absolute `http(s)://` `to`, which isn't joined with a
  local prefix.
- **`Response status={} headers={} trailers={}>{value}</Response>`** -- the
  one primitive whose children is the *same* static-value slot `Route`
  already has, just with response-shape metadata attached. Safe to add
  (unlike a `<Header>` tag, which doesn't exist) because it only ever
  decorates its **own** value, never a sibling subtree. Using `<Response>`
  as children *and* setting `headers`/`trailers` directly on `Route`
  throws -- one way to say it.

  > **Naming note**: importing `Response` (the tag) shadows the global
  > Fetch API `Response` class in that file. If you need both (e.g. a
  > handler that also calls `Response.json(...)`), alias the import:
  > `import { Response as ResponseTag } from "@johnhenry/servable"`.

### Rejected additions

Recorded so they don't get re-proposed without re-deriving why:
`<Header>`/`<Trailer>` tags (real capability, wrong shape -- `headers`/
`trailers` are props, merged through a real `Headers` instance, never
naive object-spread, since HTTP header names are case-insensitive and
`Set-Cookie` is legitimately repeatable); `<Validate>` (just another
`Use`); `<Stream>`/`<Body>` tags (already expressible via `handler`
returning a `Response` with a `ReadableStream` body -- `sse()`/
`streamBody()` are the ergonomics that were actually missing, not a new
primitive); `<Cookie>` (`setCookie()` is a header-value formatter, not a
tag); automatic route-specificity inference (**first full match in
document order wins**, always -- author orders overlapping routes
deliberately, same discipline as Express); a caching primitive built on
the Fetch `Cache` API (inconsistent support across Node/Deno/Bun/Workers,
unlike `Request`/`Response`/`Headers`/`URLPattern`); `<Video>`/`<Audio>`/
`<Image>`/`<Pdf>`/`<Download>` tags (all five are presets of the same
`src`/`download`/Range mechanism, not a different capability).

## Adding a new primitive

The "Rejected additions" list above is really one test applied nine
times: **does this need real compile-time wiring that a `Use` middleware
or an existing prop fundamentally cannot provide?** `Use` already runs
arbitrary code around a subtree at request time -- that covers anything
expressible as "inspect/modify the request, call `next()`, inspect/modify
the response" (`<Validate>`, a caching layer, auth). A prop already
covers anything that's just metadata on a single existing node
(`<Header>`/`<Trailer>` -> `headers`/`trailers`; `<Video>`/`<Pdf>` -> `src`/
`download`). Neither covers a genuinely new **scoping axis** baked into
how requests get matched in the first place, before any handler or
middleware runs at all -- that's what actually justifies a new primitive,
and it's exactly why `Host` (hostname-axis scoping, alongside `Group`'s
existing pathname-axis scoping) is real and `<Validate>` isn't.

`Host` is also the best real worked example in this package's own
history (see CHANGELOG's "Unreleased" entry) -- it follows the same
four-touchpoint shape `@johnhenry/fileable`'s own README section "Adding
a new tag" documents for its domain:

1. A `Props` interface + a `StructuralTag` union entry (`src/types.ts`) --
   `HostProps { name?: string; pattern?: string }`, `"host"` added to the
   `StructuralTag` union.
2. A one-line `structural("host", props)` factory (`src/components.ts`) --
   copy-paste of `Group`'s own.
3. A `RESERVED_TAGS` entry (`src/jsx-runtime.ts`) so the bare lowercase
   `<host>` throws a clear "use `<Host>`" error instead of silently
   becoming an unrecognized node, same as every other primitive.
4. The part that isn't boilerplate: real Layout-stage logic in
   `layout.ts`. `WalkCtx.hostname` is threaded through the tree walk the
   same way `basePath` already is; `dedupKey()` was widened to include
   `hostname` so two sibling `<Host>`s reusing the same path don't
   collide; `compilePath()` bakes `hostname` into the actual compiled
   `URLPattern` every nested `Route`/`Redirect` gets. `compile.ts`'s
   `nearestScope()` picks a hostname-specific scope over a host-agnostic
   one when both match, so a `<Host>`-scoped `NotFound` doesn't lose to
   an unscoped sibling's.

Why Layout and not Build/Resolve: `Host` has to apply **after** every
other pipeline stage has finished expanding the tree (a mounted fileable
tree, `Group from="glob"` file-based routing, a promise-valued `path`, a
literal `<Router>` nested inside a `<Host>`) -- Layout is the one stage
that runs once everything else has already produced its routes. This is
also a real bug fix, not just a design preference: `Host` used to live
one layer up, in `@johnhenry/hostable`, implemented as a one-pass
pre-Build tree rewrite -- which meant any route created by a *later*
stage was invisible to that rewrite and leaked across every `<Host>` in
the gateway (confirmed empirically: a `<Host>` that should only
reverse-proxy elsewhere also served a sibling `<Host>`'s mounted static
files). Moving the primitive itself down into servable's own Layout
stage fixed it at the root, for every expansion point at once, instead
of requiring `hostable` to special-case each one as it was found -- see
`test/host.test.ts` (19 tests, including every one of the leak points)
and hostable's own CHANGELOG for the consuming side of the fix.

Contrast with `@johnhenry/hostable`'s own "Adding a new primitive" section:
hostable only has one new leaf of its own (`Upstream`), so most of its
growth isn't a new primitive at all, it's a new forwarding mechanism on
`Upstream` -- a different, smaller-shaped problem than adding a genuinely
new tag here. And `@johnhenry/fileable`'s "Adding a new tag" section covers
the same four-touchpoint shape one layer down, for filesystem primitives
instead of HTTP ones.

## Standard Web API usage

The throughline: prefer the platform's own type over inventing a parallel
one, and only add sugar for genuine gaps.

- **`Request`/`Response`/`Headers`** -- handlers receive a *real* `Request`
  (`.json()`, `.formData()`, `.clone()`, `.signal`, `.headers.get()` all
  already work, zero wrapper). `headers`/`trailers` accept the standard
  `HeadersInit` union (`Headers | Record<string,string> | [string,string][]`),
  not a servable-specific shape.
- **`URLPattern`** -- not a global in Node 18/20/22, so `urlpattern-polyfill`
  ships as a real dependency; a native global is preferred when present
  (Deno/Bun/Workers/newer Node don't need it).
- **`WebSocket`** -- fits the existing "handler returns a `Response`" model:
  every modern runtime models an upgrade as still returning a `Response`
  (status 101, socket attached), just with different upgrade mechanics.
  `upgradeWebSocket(req)` abstracts that for **Deno and Cloudflare
  Workers** (both trivial, the platform does the hard work) and **Node**
  (via [`leserve`](https://github.com/johnhenry/leserve)'s
  `upgradeRawSocket()`, lazily imported -- Node has no built-in
  server-side WebSocket upgrade/framing at all, only a client `WebSocket`
  global since v22, so this delegates to `leserve` rather than
  reimplementing the handshake). The socket the Node branch resolves is a
  `ws` library `WebSocket` (`.on('message', ...)`), not the DOM
  `EventTarget`-style `WebSocket` Deno/Workers hand back
  (`.addEventListener(...)`) -- a real, unavoidable API difference across
  runtimes, not a bug.

## Headers and trailers

`headers` (on `Route`, `Group`, `Response`) merges through a real `Headers`
instance: later layers override earlier ones for the same name
(case-insensitively), except `Set-Cookie`, which accumulates (the one
header the Fetch spec itself special-cases this way). A `Group`'s
`headers` are inherited by every `Route` inside it; a `Route`'s own
override on top.

**Trailers aren't part of the Fetch `Response` model at all** -- they're
an HTTP/1.1 chunked-transfer-specific concept the Fetch spec doesn't
represent. `trailers` (a function receiving the streamed body, resolving
to a `HeadersInit`) is validated at dispatch time (throws if set on a
non-streaming response) and transmitted by whichever **adapter** actually
supports it -- today, only the Node adapter, via `res.addTrailers()`.

## Streaming

Already fully expressible without any special primitive: a `handler`
returning `new Response(readableStream, { headers })` just works. `sse()`
and `streamBody()` are ergonomics around building that value:

```tsx
import { sse, streamBody } from "@johnhenry/servable";

async function* events() { yield "first"; yield { data: "second", event: "update" }; }
<Route path="/events" method="GET" handler={() => sse(events())} />

async function* chunks() { yield "chunk-a"; yield "chunk-b"; }
<Route path="/download" method="GET" handler={() => streamBody(chunks())} />
```

## Mounting a fileable tree

```tsx
import { Dir, File } from "@johnhenry/fileable"; // optional peer dependency
import { Router, Group, compile } from "@johnhenry/servable";

const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["<h1>Home</h1>"] })] });
const app = <Router><Group prefix="/static" from={site} /></Router>;
// serves at /static/dist/index.html -- "dist" IS part of the URL, see "NAMING" below.
```

Runs fileable's own exported `build`/`resolve`/`layout` stages (stopping
short of Hash/Write -- nothing is written to disk) to get a real artifact
list: paths, byte-exact content, binary-safety already solved by
fileable's UTF-8-round-trip detection. `@johnhenry/fileable` is an
**optional peer dependency** (`>=0.0.3`, the first version that ships a
`./browser` subpath), lazily imported only when a `from` value duck-types
as a fileable tree -- routing-only consumers never pay for it. Under a
browser/edge bundle (`"browser"` export condition), this resolves to
`@johnhenry/fileable/browser` instead of fileable's Node main entry, so
mounting a fileable tree doesn't pull `glob` (and its `node:events`
dependency) into a browser build -- see "Browser and edge bundling" below.

**Naming**: a `Dir`/`File`'s name is *always* part of the mounted URL, root
or nested -- no special-casing. If you give the mount root a name, it
shows up in the URL, exactly like a nested `Dir`'s name already does; there
is no separate "the outermost name doesn't count" rule to remember. (An
earlier version of this package stripped the mount root's own name,
mimicking `express.static('dist')` serving `dist`'s *contents* at the
mount point without `dist` itself appearing in the URL. That analogy
didn't actually fit: Express's argument is a bare filesystem path, never
rendered anywhere, but a fileable `Dir`/`File`'s `name` is a real,
deliberately-authored part of the tree -- the only reason to give one is
for it to mean something, and the only place it can mean something here is
the URL.)

**Don't want a folder name in the URL at all?** Don't wrap the mount in a
named `Dir` -- use a Fragment (`<>...</>`) as the mount root instead. A
Fragment has no `name` of its own; its children flatten into independent
top-level artifacts, each still keeping *its own* name:

```tsx
const site = (
  <>
    <File name="index.html">{"<h1>Home</h1>"}</File>
    <File name="about.html">{"<h1>About</h1>"}</File>
  </>
);
const app = <Router><Group prefix="/static" from={site} /></Router>;
// /static/index.html and /static/about.html -- no enclosing folder name anywhere.
```

Other mapping rules: a directory's `index.html` also serves at the
directory's own path. A fileable `symlink` artifact becomes a `Redirect`,
not a duplicate route -- a symlink *means* "this path is really that other
path." An `encode="zip"`/`encode="wbn"` artifact (a `.zip` or a `.wbn`)
**isn't mounted yet** -- fileable's own archive assembly lives in its
internal `write/zip.ts`/`write/wbn.ts`, not its public API; skipped with a
warning rather than reimplemented partially (build a
`<Route src>`/`serveFile()` route by hand for a zip/wbn download in the
meantime). A fileable `Rm` node has nothing to serve; skipped with a
warning.

### Mounting without `from=`

`from=` isn't the only way in -- a fileable tree can sit directly as a raw
child of `<Router>`/`<Group>`, exactly like any other nested servable
primitive, since both frameworks' JSX is sugar over plain
`{tag,props,children}`-producing factory functions. That means fileable's
own `<Dir>`/`<File>` tags can be written **literally, nested inside
servable's `<Router>`/`<Group>` JSX, in the same expression** -- one file,
one `@jsxImportSource @johnhenry/servable` pragma, both vocabularies used
adjacently:

```tsx
/** @jsxImportSource @johnhenry/servable */
import { Dir, File } from "@johnhenry/fileable";
import { Router, Group, Route, compile } from "@johnhenry/servable";

const app = (
  <Router>
    <Group prefix="/static">
      {/* "dist" is part of the URL -- this file serves at
          /static/dist/index.html. See "Naming" above for why, and for the
          Fragment-based way to mount without a folder name at all. */}
      <Dir name="dist">
        <File name="index.html">{"<h1>Home</h1>"}</File>
      </Dir>
      <Route path="/api" method="GET">{{ ok: true }}</Route>
    </Group>
  </Router>
);
```

This works because servable's `jsx()` calls any function-typed tag
directly with its props (`type(allProps)`) rather than treating it as
markup -- so `<Dir>`/`<File>`, evaluated under servable's pragma, invoke
fileable's *own* `Dir`/`File` functions and produce real fileable
`Descriptor`s, identical to calling them by hand. `Descriptor.tag`'s type
is widened to the general `symbol` (not each package's own exact `typeof
FRAGMENT`) specifically so this type-checks: fileable's Fragment marker is
a different `Symbol.for(...)` key than servable's, and without the
widening, TypeScript rejects `<Dir>` as an invalid JSX component even
though it already worked correctly at runtime.

If you're building the tree programmatically (conditionally including a
subtree, mapping over data) rather than writing it out literally, calling
`Dir({...})`/`File({...})` as plain functions and embedding the result via
`{}` works exactly the same way -- both forms produce the same value,
JSX angle-bracket syntax is sugar over the function calls either way:

```tsx
const site = Dir({ name: "dist", children: [File({ name: "index.html", children: ["<h1>Home</h1>"] })] });
const app2 = <Router><Group prefix="/static">{site}</Group></Router>; // /static/dist/index.html
// or, with no Group at all -- mounts at the root:
const app3 = <Router>{site}</Router>; // /dist/index.html
```

Detection uses `FILEABLE_DESCRIPTOR`, a `Symbol.for("fileable.descriptor")`
global-registry brand `@johnhenry/fileable@0.0.1`+ stamps onto every
descriptor it creates -- so a raw fileable tree is recognized wherever a
servable primitive could appear as a child of `Router`/`Group`, not just
behind `from=`. Everything above (index.html-at-directory-path, symlink ->
`Redirect`, archive/`Rm` handling) applies identically either way; `from=`
and a raw child are two spellings of the same mount, not two features.

### Mounting a single bare `<File>` (no `<Dir>` needed)

A lone `<File>` -- not wrapped in a `<Dir>` -- mounts too, exactly like a
`<Dir>` does, whether named or not:

```tsx
// Named: the name is part of the URL, same as any other mount -- this
// serves at /static/page.html.
<Group prefix="/static"><File name="page.html">{"<h1>hi</h1>"}</File></Group>

// Nameless: there's no developer-supplied name to put anywhere, so it
// serves directly at the Group's own prefix, /static:
<Group prefix="/static"><File>{"<h1>hi</h1>"}</File></Group>
```

Fileable itself requires a name on any root-level `File` -- a nameless
bare `File` mounted directly as a `Group`/`Router` child gets a synthetic
internal name servable gives it purely to satisfy that requirement (never
your own name being discarded; there isn't one to discard). That synthetic
name also picks the default `Content-Type: text/html` (nameless File
content is almost always markup/text). If you need a different
`Content-Type`, give the `File` a real `name=` with the extension you want
(`name="data.json"`, `name="feed.xml"`, ...) -- at that point your own name
is used and kept, same as any other named mount, and the synthetic default
never applies.

### Fileable descriptors are only recognized under `<Router>`/`<Group>`

A `<Dir>`/`<File>` is **not** recognized as a child of `<Route>` (or
anything else) -- only `<Router>`/`<Group>` are scanned for a mounted
fileable tree. Putting one under `<Route>` throws a clear compile-time
error rather than silently doing something else:

```tsx
// Throws: "a fileable <file> descriptor can't be used here, under <route>"
<Route path="/oops" method="GET">
  <File name="x.html">{"content"}</File>
</Route>
```

For a single file's content at one specific `Route`, you almost always want
`Route`'s own body handling instead -- it already accepts a string,
`Response`, any `BodyInit`, or a plain object (JSON) as its children, plus a
dedicated `src=` prop for serving an on-disk file with correct
`Content-Type`/range-request/caching support, independent of fileable
entirely (see "Standard Web API usage" above). Reaching for fileable's
`File` here would just be solving a problem `Route` already solves on its
own -- `File`'s real job is being part of a `Dir` tree (multi-file layout,
content hashing, symlinks, ...), not a single-value response.

## Adapters

`compiled.fetch` is a plain `(Request) => Promise<Response>` -- Deno, Bun,
and Cloudflare Workers already speak this signature natively at the server
boundary, so those adapters are thin pass-throughs:

```ts
import { serve } from "@johnhenry/servable/adapters/deno"; // Deno.serve(...)
import { serve } from "@johnhenry/servable/adapters/bun";  // Bun.serve({ fetch })
import { toWorker } from "@johnhenry/servable/adapters/cloudflare"; // export default { fetch }
```

**Node** needs a real bridge -- `node:http` speaks `IncomingMessage`/
`ServerResponse`, not `Request`/`Response`. Rather than maintaining a
second, independently-drifting implementation of that conversion,
`adapters/node`'s `serve()` delegates to
[`leserve`](https://github.com/johnhenry/leserve)'s own `serve()`, which
already solves it (multi-value headers like repeated `Set-Cookie`, stream
error forwarding, the malformed-request-target edge case) -- the same
"prefer an existing, more mature implementation over reinventing it"
discipline this whole design leaned on for `Request`/`Response`/
`Headers`/`URLPattern`. `leserve` is a regular dependency (it was an
optional peer before the `servable` CLI, which always needs it), but it's
still only loaded by this adapter and the CLI, never by the main entry.

```ts
import { serve } from "@johnhenry/servable/adapters/node";
const handle = serve(compiled, {
  port: 3000,
  onListen: (info) => console.log(info.path),
  // Optional: the server's 'error' events (EADDRINUSE and other listen
  // failures). Without it, they're uncaught exceptions, as in leserve.
  onError: (error) => console.error(error.code),
});
// handle.server is the underlying http.Server (e.g. closeAllConnections()).
// later: await handle[Symbol.asyncDispose]();
```

leserve's own `serve()` doesn't return its server; the adapter finds it
through Node's `net.server.listen` diagnostics channel, which fires inside
`listen()` before any error can be emitted.

### Browser and edge bundling

`compile()`, every primitive (`Router`/`Group`/`Host`/`Route`/`Use`/
`ErrorBoundary`/`NotFound`/`Redirect`/`Response`), `Route`'s `src=`/
`serveFile()` for a `Blob`/`File`/`http(s)://`/`ipfs://` source, and
mounting a fileable tree (`<Group from={fileableTree}>`) are all
browser-safe -- `import '@johnhenry/servable'` doesn't touch a Node
built-in for any of that, and bundles cleanly under Vite/webpack/esbuild
(automatically, via the package's `"browser"` export condition on
`exports["."]` plus its internal `#resolve`/`#serve-file`/`#fileable`
self-imports -- no special config or alternate import path needed beyond
your bundler's own browser-target setup, e.g. esbuild's
`--platform=browser` or Vite's default client build). Mounting a fileable
tree resolves `@johnhenry/fileable`'s `./browser` subpath instead of its
Node main entry under this same condition, so it never pulls `glob` (and
`glob`'s `node:events` dependency) into a browser bundle.

Two capabilities are genuinely Node-only, since they read from a real local
filesystem: `<Group from="./handlers/**/*.js">` (glob-based file routing)
and `serveFile()`/`src=` given a plain local file path string. Both still
work exactly as before under Node (or a Node-targeting bundle); under a
browser/Worker bundle they throw a clear `ServableError` instead of
crashing on an empty `node:fs`/`node:path`/`glob` stub -- build your route
tree from in-memory `<Route handler={fn}>` functions instead, or serve a
`Blob`/`http(s)://`/`ipfs://` source. The same is true of a *mounted*
fileable tree's own Node-only capabilities (a local `src=` file path,
`cmd`, `<Dir from="glob">`, `env://`) -- fileable's `./browser` subpath
throws its own equivalent, clear `FileableError` for those, pointing back
at fileable's Node entry point.

## Command line

`servable serve <module>` runs an app without a hand-written server
script. It's the interface a supervisor (Sitefile Desktop, a process
manager, a test harness) drives servable through. Node only.

The module default-exports the compiled app and doesn't call `serve()`
itself:

```tsx
/** @jsxImportSource @johnhenry/servable */
import { Router, Route, compile } from "@johnhenry/servable";
export default await compile(<Router><Route path="/hello">Hello</Route></Router>);
```

```sh
npx servable serve dist/app.js --port 0 --json --watch
```

Point it at JavaScript. Node 26 strips types from `.ts`/`.mts` files, but
it doesn't transform JSX, so compile `.tsx` first (for example with `tsc`,
or `tsc --watch` next to `--watch`). See
[`examples/09-serve-cli`](./examples/09-serve-cli/app.tsx).

| Option | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on. `0` lets the OS pick a free one; the `ready` event reports it. Default `$PORT`, else 3000. |
| `--host <host>` | Interface to bind. Default `127.0.0.1`. |
| `--json` | NDJSON events on stdout (below). Without it, output is for people. |
| `--watch` | Re-import the module when a file changes (see "Watch" below). |
| `--watch-path <dir>` | What to watch; repeatable. Default: the module's directory. |
| `--public-url <origin>` | The origin clients use, e.g. `http://app.localhost`. Becomes `request.url`'s origin and `Host`. |
| `--trust-proxy` | Take `request.url`'s origin from `Forwarded`, else `X-Forwarded-Host`/`-Proto`/`-Port`. |
| `--drain-timeout <ms>` | How long shutdown waits for in-flight requests. Default 10000. |

### Events (`--json`)

With `--json`, stdout carries only events, one JSON object per line, and
the app's own `console.log`/`info`/`debug` go to stderr. Every event has
the same envelope:

```json
{"v":1,"event":"ready","time":"2026-11-10T20:40:29.886Z", ...fields}
```

`v` is the schema version. It changes only for an incompatible change (a
field removed or retyped); new fields and new events don't change it, so
ignore what you don't know.

| Event | Fields | When |
| --- | --- | --- |
| `ready` | `url`, `host`, `port`, `publicUrl` (or `null`), `module`, `pid`, `ok`, `reload` | Listening, and after every reload. `port` is the real port, even with `--port 0`. `ok: false` means the module is broken and every request gets a 500 (only under `--watch`). `reload` counts reloads, 0 at start. |
| `request` | `method`, `host`, `path` (with query), `status`, `ms` | Each response, when its headers are ready. |
| `reloading` | `files` | `--watch` saw a change. Exactly one `ready` follows. |
| `warning` | `message`, sometimes `code` | Compile warnings, `E_DRAIN_TIMEOUT`, `E_DRAIN_SKIPPED`, `E_WATCH`. |
| `error` | `code`, `message`, `fatal`, sometimes `stack`, `permission`, `errno` | `fatal: true` is followed by `stopped` and the exit code below. |
| `stopping` | `signal` | SIGTERM or SIGINT received; draining. |
| `stopped` | `exitCode`, `drained` | Last line before the process exits. |

### Error and exit codes

| Exit | Error codes | Meaning |
| --- | --- | --- |
| 0 | | Stopped by SIGTERM/SIGINT. |
| 1 | `E_INTERNAL` | Unexpected error, or an uncaught exception from the app after start. |
| 2 | `E_USAGE` | Bad command line. |
| 3 | `E_MODULE_NOT_FOUND`, `E_MODULE_LOAD`, `E_NOT_AN_APP` | The module is missing, threw while loading, or its default export isn't a compiled app. Under `--watch` these aren't fatal: the server starts anyway and serves a 500. |
| 4 | `E_LISTEN` | Couldn't listen (`errno` says why, e.g. `EADDRINUSE`). |
| 5 | `E_ACCESS_DENIED` | Node's permission model refused something (`permission` says what). |
| | `E_REQUEST` | Never fatal: a handler threw and no `<ErrorBoundary>` caught it. The client gets a 500. |

### Lifecycle

- **SIGTERM or SIGINT** stops accepting connections, waits for in-flight
  requests (up to `--drain-timeout`; connections still open then are
  closed), then exits 0. A second signal exits
  at once. On Windows there's no catchable SIGTERM, so a supervisor's kill
  is immediate.
- **Watch.** `--watch` re-imports the module in the same process, so the
  socket and port never change. Files under the watched directories are
  re-evaluated; packages in `node_modules` aren't. If the new version fails
  to load, the server answers every request with a 500 showing the error
  until the next good save. It's a re-import, not a restart: timers or
  sockets the old version opened at module level keep running, and each
  reload keeps the old module copies in memory. Restart the process to
  reset those.

### Behind a proxy

A proxy that keeps the `Host` header (like Sitefile Desktop's `*.localhost`
name router) needs nothing: `request.url` already has that host, and
`<Host>` matches it. For a proxy that rewrites `Host`, either pass
`--public-url` (fixed; forwarded headers are then ignored), or
`--trust-proxy` to read `Forwarded`/`X-Forwarded-*` per request. Only use
`--trust-proxy` when the server is reachable through the proxy alone, since
clients can set those headers themselves. `X-Forwarded-For` isn't used.

### Node's permission model

The CLI runs under `node --permission`. It needs:

- `--allow-fs-read` covering the module, the files it imports, and the
  `node_modules` holding servable and leserve. Usually that's just the
  project directory.
- `--allow-net`, to listen. Node 26 has one network switch, not per host.
  Without it the CLI exits 5 with `E_ACCESS_DENIED` before trying.

It needs no `--allow-fs-write` and no `--allow-child-process`. `--watch`
needs nothing extra. Whatever the app itself does (writing files,
`fetch()` to other hosts, spawning processes) needs its own grants;
denied calls inside a handler become 500s with an `E_REQUEST` event, and
denied reads while loading are `E_ACCESS_DENIED`.

```sh
node --permission --allow-fs-read="$PWD" --allow-net \
  node_modules/@johnhenry/servable/dist/src/cli.js serve dist/app.js --port 0 --json
```

Run the project's own servable (`npx servable` or the path above), not a
global install: the CLI and the app must share one copy of servable for
trailers to reach the wire.

## Non-goals

- Not a full HTTP server implementation -- ships a compiler + adapters,
  not a framework with its own server internals beyond the Node bridge.
- No ORM/templating/sessions. `setCookie()` formats a header value; it is
  not a session store.
- No hot module replacement. `servable serve --watch` re-imports the app
  on change; it doesn't push updates to browsers, keep module state across
  reloads, or tear down what the old version started (see "Lifecycle").
- The CLI is Node only. Deno, Bun and Workers use their adapters.
- No process supervision: the CLI doesn't restart itself after a crash or
  daemonize. That's the supervisor's job; the exit codes are for it.
- No plugin/middleware-registry system beyond what JSX composition already
  expresses.
- No built-in proxy or per-route timeout (mechanism already decided for
  later: `fetch()` for proxying, `AbortSignal.timeout()` for timeouts --
  neither built yet).

## Examples

See [`examples/`](./examples) (and its own
[`examples/README.md`](./examples/README.md) index): `01-hello-world`,
`02-crud-api` (static + dynamic `Route` mix, `<Response>`),
`03-middleware-auth` (`Use`/`ErrorBoundary` composition),
`04-file-based-routing` (`Group from="glob"`), `05-streaming`
(`sse()`/`streamBody()`), `06-media-serving` (`src`/`download`/Range),
`07-mount-fileable`, `08-mount-packfile`.

## Family

servable is the middle package in the `fileable -> servable -> hostable`
lineage -- a real, direct dependency runs through it in both directions:
it optionally consumes fileable's output, and hostable depends on it
outright to do its own job.

- **[`@johnhenry/fileable`](https://github.com/johnhenry/fileable)** --
  fileable's `<Dir>`/`<File>` trees mount directly as static routes, either
  via `Group from={fileableTree}` or as a raw JSX child of `<Router>`/
  `<Group>` (see "Mounting a fileable tree" above). `@johnhenry/fileable`
  is an **optional peer dependency**, lazily imported only when a mount
  actually duck-types as a fileable tree -- routing-only consumers of this
  package never pay for it.
- **[`@johnhenry/hostable`](https://github.com/johnhenry/hostable)** --
  hostable is built directly on top of this package: `Group`/`Host`/
  `Route`/`Use`/`ErrorBoundary`/`NotFound`/`Redirect`/`Response` are all
  re-exported from here unchanged, and hostable's own `compile()` delegates
  to this package's `compile()` for everything below `<Host>`. `Host`
  itself -- the domain-axis scope hostable is named after -- lives in this
  package's own Layout stage (moved down from an earlier hostable-only
  pre-transform; see "Adding a new primitive" above for the fix), so
  hostable gets it for free rather than re-implementing it.
- **[`@johnhenry/leserve`](https://github.com/johnhenry/leserve)** -- the
  Node adapter (`adapters/node`) delegates to leserve's own `serve()`
  rather than maintaining a second `IncomingMessage`/`ServerResponse` ->
  `Request`/`Response` bridge. `@johnhenry/leserve` is a regular
  dependency, loaded only by that adapter and the `servable` CLI.

## License

MIT

## Source

[github.com/johnhenry/servable](https://github.com/johnhenry/servable)
