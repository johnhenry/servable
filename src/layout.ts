/**
 * Stage 3: Layout.
 *
 * Two passes over the already-resolved tree:
 *  1. Walk top-down, accumulating `Group` prefixes (same posixPath.join-style
 *     basePath accumulation as fileable's layout.ts), compiling each
 *     `Route`'s `path` to a URLPattern, assigning method+pattern, throwing
 *     on two Routes claiming the same method+path (direct reuse of
 *     fileable's duplicate-output-path check), and assembling each Route's
 *     `Use`/`ErrorBoundary` wrapper chain from tree containment (ancestors,
 *     root to leaf -- never sibling order, see the design plan's governing
 *     rule). `Group`/`Router` nodes also register as "scopes" so `NotFound`
 *     can resolve nearest-scope-wins on a request that matches no route.
 *  2. Substitute every `LinkRef` now that every route's final path is known
 *     (same two-pass "resolve once the full table exists" approach as
 *     fileable's LinkRef substitution) -- and populate a registry `linkTo()`
 *     itself also reads at runtime, for calls made *inside* a handler body
 *     (which only run per-request, long after compile() has finished; see
 *     api.ts's linkTo() for the two-mode explanation).
 */
import { join as posixJoin } from "node:path/posix";
import { isDescriptor, isLinkRef, ServableError } from "./types.js";
import type {
  Descriptor,
  DescriptorChild,
  ErrorHandler,
  HeadersInputOrFn,
  Middleware,
  TrailersInputOrFn,
} from "./types.js";
import { compilePath, URLPatternImpl } from "./urlpattern.js";
import { linkRegistry } from "./link-registry.js";

export type WrapperFrame = { kind: "use"; middleware: Middleware } | { kind: "errorboundary"; handler: ErrorHandler };

export interface CompiledRoute {
  method: string;
  pattern: InstanceType<typeof URLPatternImpl>;
  descriptor: Descriptor;
  chain: WrapperFrame[];
  headersLayers: HeadersInputOrFn[];
  trailers?: TrailersInputOrFn;
}

export interface CompiledRedirect {
  pattern: InstanceType<typeof URLPatternImpl>;
  to: string;
  status: number;
  chain: WrapperFrame[];
}

export interface CompiledScope {
  prefix: string;
  /** The <Host>'s own name/pattern this scope is nested under, if any -- undefined means "no Host ancestor", not "matches every Host" (see compile.ts's nearestScope, which still lets a host-agnostic scope match any hostname when no more specific one does). */
  hostname?: string;
  /** Precompiled once here (not per-request in compile.ts) -- a hostname-only URLPattern, present iff `hostname` is. */
  hostnamePattern?: InstanceType<typeof URLPatternImpl>;
  chain: WrapperFrame[];
  notFoundHandler?: Descriptor["props"]["handler"];
  notFoundStatic?: DescriptorChild[];
}

export interface LayoutResult {
  routes: CompiledRoute[];
  redirects: CompiledRedirect[];
  scopes: CompiledScope[];
  warnings: string[];
}

interface WalkCtx {
  basePath: string;
  /** Set once inside a <Host> -- undefined outside any Host, meaning "match any hostname" (unchanged pre-Host behavior). */
  hostname?: string;
  chain: WrapperFrame[];
  headersLayers: HeadersInputOrFn[];
}

export function layout(roots: Descriptor[]): LayoutResult {
  const routes: CompiledRoute[] = [];
  const redirects: CompiledRedirect[] = [];
  const scopes: CompiledScope[] = [];
  const warnings: string[] = [];
  const dedup = new Map<string, string>();
  const linkTargets = new Map<Descriptor, string>();

  function dedupKey(method: string, finalPath: string | InstanceType<typeof URLPatternImpl>, hostname: string | undefined): string {
    // hostname included even for the string-path case -- finalPath is the
    // raw joined path BEFORE compilePath() bakes hostname into the actual
    // pattern, so two <Host>s reusing the same pathname must not collide
    // here (the real bug this dedup key fix closes: two sibling Hosts
    // could never both have e.g. GET /health before this).
    if (typeof finalPath === "string") return `${method}::${hostname ?? ""}::${finalPath}`;
    return `${method}::urlpattern:${finalPath.protocol}|${finalPath.hostname}|${finalPath.pathname}|${finalPath.search}`;
  }

  function scopeFor(basePath: string, hostname: string | undefined): CompiledScope {
    let scope = scopes.find((s) => s.prefix === basePath && s.hostname === hostname);
    if (!scope) {
      scope = {
        prefix: basePath,
        hostname,
        hostnamePattern: hostname === undefined ? undefined : new URLPatternImpl({ hostname }),
        chain: [],
      };
      scopes.push(scope);
    }
    return scope;
  }

  function walk(node: Descriptor, ctx: WalkCtx, path: string): void {
    switch (node.tag) {
      case "router": {
        scopeFor(ctx.basePath, ctx.hostname).chain = ctx.chain;
        for (const child of node.children) walkChild(child, ctx, `${path} > router`);
        return;
      }
      case "group": {
        const prefix = (node.props.prefix as string | undefined) ?? "";
        const nextBasePath = posixJoin(ctx.basePath, prefix);
        const nextHeadersLayers =
          node.props.headers !== undefined ? [...ctx.headersLayers, node.props.headers as HeadersInputOrFn] : ctx.headersLayers;
        const nextCtx: WalkCtx = { basePath: nextBasePath, hostname: ctx.hostname, chain: ctx.chain, headersLayers: nextHeadersLayers };
        scopeFor(nextBasePath, ctx.hostname).chain = ctx.chain;
        for (const child of node.children) walkChild(child, nextCtx, `${path} > group[${prefix}]`);
        return;
      }
      case "host": {
        if (ctx.hostname !== undefined) {
          throw new ServableError("<Host> cannot be nested inside another <Host>", path);
        }
        const name = node.props.name as string | undefined;
        const pattern = node.props.pattern as string | undefined;
        const hostname = pattern ?? name;
        if (!hostname) {
          throw new ServableError("<Host> requires a `name` or `pattern` prop", path);
        }
        const nextCtx: WalkCtx = { ...ctx, hostname };
        scopeFor(ctx.basePath, hostname).chain = ctx.chain;
        for (const child of node.children) walkChild(child, nextCtx, `${path} > host[${hostname}]`);
        return;
      }
      case "use": {
        const middleware = node.props.middleware as Middleware | undefined;
        if (typeof middleware !== "function") {
          throw new ServableError('<Use> requires a `middleware` function prop', path);
        }
        const nextCtx: WalkCtx = { ...ctx, chain: [...ctx.chain, { kind: "use", middleware }] };
        for (const child of node.children) walkChild(child, nextCtx, `${path} > use`);
        return;
      }
      case "errorboundary": {
        const handler = node.props.handler as ErrorHandler | undefined;
        if (typeof handler !== "function") {
          throw new ServableError('<ErrorBoundary> requires a `handler` function prop', path);
        }
        const nextCtx: WalkCtx = { ...ctx, chain: [...ctx.chain, { kind: "errorboundary", handler }] };
        for (const child of node.children) walkChild(child, nextCtx, `${path} > errorboundary`);
        return;
      }
      case "notfound": {
        const scope = scopeFor(ctx.basePath, ctx.hostname);
        scope.chain = ctx.chain;
        if (typeof node.props.handler === "function") {
          scope.notFoundHandler = node.props.handler;
        } else {
          scope.notFoundStatic = node.children;
        }
        return;
      }
      case "redirect": {
        const from = node.props.from as string | undefined;
        const to = node.props.to as string | undefined;
        if (!from || !to) {
          throw new ServableError('<Redirect> requires both `from` and `to`', path);
        }
        // `to` is Group-relative too, same as `from`/Route's `path` --
        // consistent with everything else in a scope being scope-relative
        // by default -- except an absolute http(s):// URL, which obviously
        // isn't meant to be joined with a local path prefix.
        const resolvedTo = /^https?:\/\//.test(to) ? to : posixJoin(ctx.basePath, to);
        redirects.push({
          pattern: compilePath(posixJoin(ctx.basePath, from), ctx.hostname),
          to: resolvedTo,
          status: (node.props.status as number | undefined) ?? 301,
          chain: ctx.chain,
        });
        return;
      }
      case "response": {
        throw new ServableError("<Response> can only be used as <Route>'s children, not on its own here", path);
      }
      case "route": {
        compileRoute(node, ctx, path);
        return;
      }
      default:
        throw new ServableError(`<${String(node.tag)}> is not a servable primitive here`, path);
    }
  }

  function compileRoute(node: Descriptor, ctx: WalkCtx, path: string): void {
    const rawPath = node.props.path as string | InstanceType<typeof URLPatternImpl> | undefined;
    if (rawPath === undefined) {
      throw new ServableError("<Route> requires a `path` prop", path);
    }
    const method = ((node.props.method as string | undefined) ?? "GET").toUpperCase();

    const hasHandler = node.props.handler !== undefined;
    const hasSrc = node.props.src !== undefined;
    const hasChildren = node.children.length > 0;
    if ([hasHandler, hasSrc, hasChildren].filter(Boolean).length > 1) {
      throw new ServableError(
        "<Route> can only use one of `handler`, `src`, or static children -- not more than one",
        path,
      );
    }

    // path="/" means "this Group's own prefix, exactly" -- posixJoin("/users", "/")
    // produces "/users/" (trailing slash), which wouldn't match a request
    // for "/users" (no trailing slash), the form real REST APIs expect. The
    // *canonical* path (used for linkTo()/dedup) stays clean ("/users"),
    // but the *match pattern* additionally accepts an optional trailing
    // slash (via URLPattern's own "{/}?" optional-group syntax) so
    // "/users/" -- the form a browser naturally uses for a mounted
    // directory index -- still matches the same route.
    const isBareGroupRoot = typeof rawPath === "string" && rawPath === "/" && ctx.basePath !== "";
    const finalPath =
      typeof rawPath === "string" ? (rawPath === "/" ? ctx.basePath || "/" : posixJoin(ctx.basePath, rawPath)) : rawPath;
    const patternSource = isBareGroupRoot ? `${ctx.basePath}{/}?` : finalPath;
    const key = dedupKey(method, finalPath, ctx.hostname);
    if (dedup.has(key)) {
      throw new ServableError(
        `duplicate route: ${method} ${typeof finalPath === "string" ? finalPath : "[URLPattern]"} -- two <Route>s both resolve here`,
        path,
      );
    }
    dedup.set(key, path);

    const headersLayers =
      node.props.headers !== undefined ? [...ctx.headersLayers, node.props.headers as HeadersInputOrFn] : ctx.headersLayers;

    routes.push({
      method,
      pattern: compilePath(patternSource, ctx.hostname),
      descriptor: node,
      chain: ctx.chain,
      headersLayers,
      trailers: node.props.trailers as TrailersInputOrFn | undefined,
    });

    if (typeof finalPath === "string") linkTargets.set(node, finalPath);
  }

  function walkChild(child: DescriptorChild, ctx: WalkCtx, path: string): void {
    if (isDescriptor(child)) walk(child, ctx, path);
    else if (Array.isArray(child)) for (const c of child) walkChild(c, ctx, path);
  }

  for (const root of roots) {
    walk(root, { basePath: "", chain: [], headersLayers: [] }, String(root.tag));
  }

  // --- Pass 2: LinkRef substitution + populate the runtime linkTo() registry ---
  linkRegistry.clear();
  for (const [descriptor, finalPath] of linkTargets) linkRegistry.set(descriptor, finalPath);

  function resolveLinkRefString(target: Descriptor | string, refPath: string): string {
    if (typeof target === "string") return target;
    const resolved = linkTargets.get(target);
    if (resolved === undefined) {
      throw new ServableError("linkTo() target is not a <Route> present in this tree", refPath);
    }
    return resolved;
  }

  function substitute(node: Descriptor, path: string): void {
    for (const [key, value] of Object.entries(node.props)) {
      if (isLinkRef(value)) node.props[key] = resolveLinkRefString(value.target, path);
    }
    node.children = substituteChildren(node.children, path);
  }

  function substituteChildren(children: DescriptorChild[], path: string): DescriptorChild[] {
    return children.map((child): DescriptorChild => {
      if (Array.isArray(child)) return substituteChildren(child, path);
      if (isLinkRef(child)) return resolveLinkRefString(child.target, path);
      if (isDescriptor(child)) {
        substitute(child, path);
        return child;
      }
      return child;
    });
  }

  for (const root of roots) substitute(root, String(root.tag));

  return { routes, redirects, scopes, warnings };
}
