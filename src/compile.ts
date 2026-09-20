/**
 * Stage 4: Compile (replaces fileable's Write -- nothing is written to
 * disk). Produces one `(Request) => Promise<Response>` dispatcher: matches
 * the incoming request against the compiled route table (first match in
 * document order wins -- routes checked first, then redirects, both in
 * their own document order; no automatic specificity inference, same
 * discipline as Express), runs the matched route's `Use`/`ErrorBoundary`
 * chain onion-style around the handler (or the resolved static value),
 * returns the result.
 */
import { isDescriptor, ServableError } from "./types.js";
import type { CompileOptions, CompileResult, Descriptor, DescriptorChild, RouteContext } from "./types.js";
import { build } from "./build.js";
import { resolve as resolveTree } from "./resolve.js";
import { layout, type CompiledRoute, type CompiledScope, type WrapperFrame } from "./layout.js";
import { serveSrcProp } from "./serve-file.js";
import { mergeHeaders, resolveHeadersInputOrFn } from "./headers-util.js";
import { drainWarnings } from "./context.js";
import { cloneDescriptorTree } from "./types.js";

/** Response instances awaiting adapter-specific trailer transmission (HTTP trailers aren't part of the Fetch Response model -- see README's "Trailers" section). */
export const pendingTrailers = new WeakMap<globalThis.Response, Promise<Headers>>();

function isBodyInitValue(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream
  );
}

/** Generic markup children (any non-structural tag) serialize to an HTML string, same idea as fileable's markup serialization. */
function serializeMarkup(children: DescriptorChild[]): string {
  return children
    .map((child): string => {
      if (child === null || child === undefined || typeof child === "boolean") return "";
      if (Array.isArray(child)) return serializeMarkup(child);
      if (typeof child === "string") return child;
      if (typeof child === "number") return String(child);
      if (isDescriptor(child)) {
        const attrs = Object.entries(child.props)
          .filter(([, v]) => typeof v === "string" || typeof v === "number" || (typeof v === "boolean" && v))
          .map(([k, v]) => (typeof v === "boolean" ? ` ${k}` : ` ${k}="${String(v)}"`))
          .join("");
        return `<${String(child.tag)}${attrs}>${serializeMarkup(child.children)}</${String(child.tag)}>`;
      }
      return "";
    })
    .join("");
}

async function resolveResponseTag(
  node: Descriptor,
  req: Request,
): Promise<globalThis.Response> {
  const status = node.props.status as number | undefined;
  const headersInput = node.props.headers !== undefined ? await resolveHeadersInputOrFn(node.props.headers as never, req) : undefined;
  const inner = await resolveStaticChildren(node.children, req, {
    status,
    headers: headersInput ? mergeHeaders(headersInput) : undefined,
  });
  if (node.props.trailers !== undefined) {
    attachTrailers(inner, node.props.trailers as never, req);
  }
  return inner;
}

async function resolveStaticChildren(
  children: DescriptorChild[],
  req: Request,
  base: { status?: number; headers?: Headers } = {},
): Promise<globalThis.Response> {
  const status = base.status ?? 200;
  if (children.length === 0) {
    return new globalThis.Response(null, { status, headers: base.headers });
  }
  if (children.length === 1 && isDescriptor(children[0]) && children[0].tag === "response") {
    return resolveResponseTag(children[0], req);
  }
  if (children.length === 1) {
    const only = children[0];
    if (only instanceof globalThis.Response) return only;
    if (typeof only === "string") {
      // A bare string is plain text; JSX *markup* children (below) serialize
      // to HTML -- these are deliberately different, same as
      // <Route path="/health">OK</Route> (text/plain) vs.
      // <Route path="/about"><h1>About</h1></Route> (text/html).
      const headers = mergeHeaders(base.headers ?? new Headers(), { "Content-Type": "text/plain; charset=utf-8" });
      return new globalThis.Response(only, { status, headers });
    }
    if (!isDescriptor(only) && isBodyInitValue(only)) {
      const headers = base.headers ?? new Headers();
      return new globalThis.Response(only as BodyInit, { status, headers });
    }
    if (typeof only === "object" && only !== null && !isDescriptor(only)) {
      const headers = mergeHeaders(base.headers ?? new Headers(), { "Content-Type": "application/json" });
      return new globalThis.Response(JSON.stringify(only), { status, headers });
    }
  }
  // Multiple children, or a single Descriptor (JSX markup) child -> HTML.
  const html = serializeMarkup(children);
  const headers = mergeHeaders(base.headers ?? new Headers(), { "Content-Type": "text/html; charset=utf-8" });
  return new globalThis.Response(html, { status, headers });
}

function attachTrailers(response: globalThis.Response, trailersInput: unknown, req: Request): void {
  if (!(response.body instanceof ReadableStream)) {
    throw new ServableError(
      "trailers is set but the response body isn't a stream -- HTTP trailers only apply to a chunked/streamed response",
      "trailers",
    );
  }
  const resolved = (async () => {
    const value = typeof trailersInput === "function" ? await (trailersInput as (body: unknown) => unknown)(response.body) : trailersInput;
    return mergeHeaders(value as never);
  })();
  pendingTrailers.set(response, resolved);
}

/**
 * A completed WebSocket upgrade (see api.ts's upgradeWebSocket()) can't be
 * a real `Response` -- the Fetch spec's constructor rejects any status
 * outside 200-599, and a status-101 marker deliberately isn't one (Deno's
 * own upgrade response and leserve's WEBSOCKET_UPGRADE_RESPONSE both work
 * this way). Recognized purely by `.status === 101` and passed through
 * untouched -- the socket has already been handed off, so there's nothing
 * left to merge headers onto or otherwise process.
 */
function isWebSocketUpgradeResponse(response: unknown): boolean {
  return !!response && typeof response === "object" && (response as { status?: number }).status === 101;
}

async function applyRouteHeaders(
  response: globalThis.Response,
  route: CompiledRoute,
  req: Request,
): Promise<globalThis.Response> {
  if (isWebSocketUpgradeResponse(response)) return response;
  if (route.headersLayers.length === 0) return response;
  const resolvedLayers = await Promise.all(route.headersLayers.map((layer) => resolveHeadersInputOrFn(layer, req)));
  const merged = mergeHeaders(response.headers, ...resolvedLayers);
  return new globalThis.Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

async function runChain(chain: WrapperFrame[], req: Request, ctx: RouteContext, core: () => Promise<globalThis.Response>): Promise<globalThis.Response> {
  let index = -1;
  async function dispatch(i: number): Promise<globalThis.Response> {
    if (i <= index) throw new ServableError("next() called more than once", "middleware chain");
    index = i;
    const frame = chain[i];
    if (!frame) return core();
    if (frame.kind === "use") {
      return frame.middleware(req, ctx, () => dispatch(i + 1));
    }
    // errorboundary
    try {
      return await dispatch(i + 1);
    } catch (error) {
      return frame.handler(error, req, ctx);
    }
  }
  return dispatch(0);
}

async function executeRoute(route: CompiledRoute, req: Request, ctx: RouteContext): Promise<globalThis.Response> {
  return runChain(route.chain, req, ctx, async () => {
    const node = route.descriptor;
    const hasResponseChild = node.children.length === 1 && isDescriptor(node.children[0]) && node.children[0].tag === "response";
    if (hasResponseChild && (node.props.headers !== undefined || node.props.trailers !== undefined)) {
      throw new ServableError(
        "<Route> headers/trailers conflict with using <Response> as children -- set one or the other",
        String(node.__id),
      );
    }

    let response: globalThis.Response;
    if (typeof node.props.handler === "function") {
      response = await (node.props.handler as (req: Request, ctx: RouteContext) => globalThis.Response | Promise<globalThis.Response>)(req, ctx);
    } else if (node.props.src !== undefined) {
      response = await serveSrcProp(req, ctx, node.props.src as never, {
        download: node.props.download as boolean | string | undefined,
      });
    } else {
      response = await resolveStaticChildren(node.children, req);
      if (node.props.trailers !== undefined) attachTrailers(response, node.props.trailers, req);
    }
    return applyRouteHeaders(response, route, req);
  });
}

async function executeNotFound(scope: CompiledScope | undefined, req: Request): Promise<globalThis.Response> {
  const ctx: RouteContext = { params: {} };
  const core = async (): Promise<globalThis.Response> => {
    if (scope?.notFoundHandler) {
      return (scope.notFoundHandler as (req: Request, ctx: RouteContext) => globalThis.Response | Promise<globalThis.Response>)(req, ctx);
    }
    if (scope?.notFoundStatic) {
      return resolveStaticChildren(scope.notFoundStatic, req, { status: 404 });
    }
    return new globalThis.Response("Not Found", { status: 404 });
  };
  if (!scope) return core();
  return runChain(scope.chain, req, ctx, core);
}

/**
 * Nearest-scope-wins: the deepest matching scope that actually declares its
 * *own* NotFound wins; a scope with no NotFound of its own bubbles out to
 * the next ancestor's rather than falling straight to the generic 404
 * (same nearest-ancestor pattern as ErrorBoundary). The deepest matching
 * scope's own chain still applies even when none declare a NotFound at all
 * -- its middleware should still wrap its own 404 handling, generic or not.
 */
function nearestScope(scopes: CompiledScope[], pathname: string): CompiledScope | undefined {
  const candidates = scopes.filter((s) => s.prefix === "" || pathname === s.prefix || pathname.startsWith(`${s.prefix}/`));
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);
  return candidates.find((s) => s.notFoundHandler || s.notFoundStatic) ?? candidates[0];
}

export async function compile(tree: unknown, options: CompileOptions = {}): Promise<CompileResult> {
  const cloned = cloneDescriptorTree(tree);
  const builtRoots = build(cloned);
  const resolvedRoots = await resolveTree(builtRoots, options);
  const laidOut = layout(resolvedRoots);

  async function dispatch(req: Request): Promise<globalThis.Response> {
    const url = new URL(req.url);

    for (const route of laidOut.routes) {
      if (route.method !== req.method.toUpperCase()) continue;
      const match = route.pattern.exec(req.url);
      if (!match) continue;
      const params = (match as unknown as { pathname: { groups: Record<string, string | undefined> } }).pathname.groups;
      return executeRoute(route, req, { params });
    }

    for (const redirect of laidOut.redirects) {
      const match = redirect.pattern.exec(req.url);
      if (!match) continue;
      return runChain(redirect.chain, req, { params: {} }, async () =>
        new globalThis.Response(null, { status: redirect.status, headers: { Location: redirect.to } }),
      );
    }

    return executeNotFound(nearestScope(laidOut.scopes, url.pathname), req);
  }

  return { fetch: dispatch, warnings: [...laidOut.warnings, ...drainWarnings()] };
}
