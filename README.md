# servable

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
    URL, an already-built `Blob`, or a function of the request returning
    one of those. Gets Range support **on by default** (206 Partial
    Content, `Accept-Ranges`, `Content-Range`, via `Blob.prototype.slice()`),
    conditional requests (`ETag`/`If-None-Match` -> 304), and correct `HEAD`
    handling. `download` (boolean or a filename string) sets
    `Content-Disposition: attachment`. This is the *one* mechanism behind
    video/audio/image/pdf/download serving -- deliberately not five
    media-specific tags, the same restraint fileable's `<File src>` already
    applies to binary content generally. The same logic is available as a
    standalone `serveFile(req, source, options)` helper for handlers that
    need logic around it (auth-gated files, a computed path).
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
  `(req, next, ctx) => Response | Promise<Response>`; not calling `next()`
  is the short-circuit (no special ceremony). Composition is **onion-style**
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
  Workers** (both trivial, the platform does the hard work). **Node has no
  implementation in this version** -- Node has no built-in server-side
  WebSocket upgrade/framing at all (only a client `WebSocket` global since
  v22), and implementing that correctly from a raw socket (handshake,
  opcodes, masking, fragmentation, ping/pong, close frames) is real
  protocol work; `upgradeWebSocket()` throws a clear error on Node rather
  than shipping an unverified bridge.

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
```

Runs fileable's own exported `build`/`resolve`/`layout` stages (stopping
short of Hash/Write -- nothing is written to disk) to get a real artifact
list: paths, byte-exact content, binary-safety already solved by
fileable's UTF-8-round-trip detection. `@johnhenry/fileable` is an
**optional peer dependency**, lazily imported only when a `from` value
duck-types as a fileable tree -- routing-only consumers never pay for it.

Mapping rules: mounting means "serve what's *inside* this tree at the
Group's prefix" (the root Descriptor's own name is fileable's container
name, not part of the URL space, so it's stripped -- same as
`express.static('dist')` under `/static` serving `dist`'s contents at
`/static/...`, not `/static/dist/...`). A directory's `index.html` also
serves at the directory's own path. A fileable `symlink` artifact becomes
a `Redirect`, not a duplicate route -- a symlink *means* "this path is
really that other path." An `as="archive"` artifact (a `.zip`) **isn't
mounted yet** -- fileable's zip assembly lives in its internal
`write/archive.ts`, not its public API; skipped with a warning rather than
reimplemented partially (build a `<Route src>`/`serveFile()` route by hand
for a zip download in the meantime). A fileable `Rm` node has nothing to
serve; skipped with a warning.

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
`ServerResponse`, not `Request`/`Response` -- so `adapters/node`'s `serve()`
does the actual work: headers, streamed bodies both directions, and
(best-effort) HTTP trailers via `res.addTrailers()`.

```ts
import { serve } from "@johnhenry/servable/adapters/node";
serve(compiled, { port: 3000 });
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

See [`examples/`](./examples): `01-hello-world`, `02-crud-api` (static +
dynamic `Route` mix, `<Response>`), `03-middleware-auth` (`Use`/
`ErrorBoundary` composition), `04-file-based-routing` (`Group from="glob"`),
`05-streaming` (`sse()`/`streamBody()`), `06-media-serving` (`src`/
`download`/Range), `07-mount-fileable`.

## License

MIT

## Source

[github.com/johnhenry/servable](https://github.com/johnhenry/servable)
