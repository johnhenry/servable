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
**optional peer dependency**, lazily imported only when a `from` value
duck-types as a fileable tree -- routing-only consumers never pay for it.

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
`Headers`/`URLPattern`. `leserve` is an **optional peer dependency**, only
needed if you use this adapter.

```ts
import { serve } from "@johnhenry/servable/adapters/node";
const handle = serve(compiled, { port: 3000, onListen: (info) => console.log(info.path) });
// later: await handle[Symbol.asyncDispose]();
```

## Non-goals

- Not a full HTTP server implementation -- ships a compiler + adapters,
  not a framework with its own server internals beyond the Node bridge.
- No ORM/templating/sessions. `setCookie()` formats a header value; it is
  not a session store.
- No hot-reload/watch mode.
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
  `Request`/`Response` bridge. `@johnhenry/leserve` is an **optional peer
  dependency**, only needed by that one adapter.

## License

MIT

## Source

[github.com/johnhenry/servable](https://github.com/johnhenry/servable)
