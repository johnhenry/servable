# servable examples

Runnable TSX servers, each a real, compiled `(Request) => Response`
dispatcher started via the Node adapter. They compile alongside `src/`/
`adapters/` (see `tsconfig.json`'s `include`), so `npm run build`
typechecks every example against the current API. Every file's own header
comment states its exact run command and a few `curl` calls to try against
it once running.

| Example | Demonstrates |
| --- | --- |
| [`01-hello-world/server.tsx`](./01-hello-world/server.tsx) | Nested JSX from the first example onward: fileable's `<Dir>`/`<File>` written literally alongside servable's `<Route>`s under one `@jsxImportSource`, no `from=` indirection. |
| [`02-crud-api/server.tsx`](./02-crud-api/server.tsx) | Static + dynamic `Route` mix, and `<Response>` for a declarative non-200 status without writing a handler function. |
| [`03-middleware-auth/server.tsx`](./03-middleware-auth/server.tsx) | `Use`/`ErrorBoundary` composition -- containment decides scope, not sibling order: only what's nested inside `<Use>` is protected. |
| [`04-file-based-routing/server.tsx`](./04-file-based-routing/server.tsx) | `<Group from="glob">` file-based routing: one `Route` per named HTTP-method export in each matched handler module, subdirectory structure preserved. |
| [`05-streaming/server.tsx`](./05-streaming/server.tsx) | `sse()`/`streamBody()` -- both already fully expressible via a `handler` returning a `Response` with a `ReadableStream` body; these are ergonomics, not a new primitive. |
| [`06-media-serving/server.tsx`](./06-media-serving/server.tsx) | `src`/`download` on `<Route>`: Range support on by default (206 partial content), `ETag`/`If-None-Match`, `Content-Disposition` -- one mechanism behind video/audio/image/pdf/download serving. |
| [`07-mount-fileable/server.tsx`](./07-mount-fileable/server.tsx) | A fileable Descriptor tree mounted as a raw child of `<Group>` -- fileable describes the virtual filesystem, servable serves it, zero disk writes in between. |
| [`08-mount-packfile/server.tsx`](./08-mount-packfile/server.tsx) | Serving a `packfile`-packaged directory through servable: `packfile`'s `createRouter()` already produces the exact `(Request) => Response` shape `Route`'s `handler` prop accepts -- no new servable primitive needed. |

## Running

```sh
npm run build
node dist/examples/01-hello-world/server.js
# then, per that example's own header comment:
curl http://localhost:3000/hello
```

Each example listens on its own fixed port (3000-3007, in file order) so
several can run side by side; see each file's header comment for its exact
port and `curl` calls.

## Runtime requirements (honest edition)

All eight run under plain Node >= 26 via the Node adapter
(`adapters/node`, which delegates to `@johnhenry/leserve`'s `serve()`).
`compiled.fetch` itself is a plain `(Request) => Promise<Response>` and
would run identically under Deno/Bun/Cloudflare Workers adapters -- these
examples specifically exercise the Node path because that's the one
requiring a real bridge (`IncomingMessage`/`ServerResponse` ->
`Request`/`Response`), the part most likely to regress.
