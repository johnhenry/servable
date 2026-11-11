/**
 * What an app answers: its routes, grouped by `<Host>`, as data (issue
 * #21). `servable routes` and `servable serve --json`'s `routes` event print
 * this; hostable's gateway report (`hostable routes`) is the same structure
 * plus the `url=` backends it forwards to, so a supervisor reads one shape
 * for both.
 *
 * It's read off Layout's own output (the table the dispatcher matches
 * against), so mounted fileable trees, `Group from=` globs and promise-valued
 * paths are listed too, not only literal `<Route>`s.
 *
 * Nothing here runs a handler, reads a `src=` file or touches the network.
 */
import { build } from "./build.js";
import { resolve as resolveTree } from "#resolve";
import { layout, type LayoutResult } from "./layout.js";
import { linkRegistry } from "./link-registry.js";
import { mountedDescriptors } from "./mount-fileable.js";
import { cloneDescriptorTree } from "./types.js";
import type { CompileOptions, Descriptor } from "./types.js";

/**
 * How a route answers:
 * - `handler`: a `handler=` function (including `Group from="glob"` modules);
 * - `static`: static children (text, markup, JSON, `<Response>`);
 * - `src`: a `src=` file, URL or Blob;
 * - `redirect`: a `<Redirect>` (`redirect` and `status` say where and how);
 * - `mount`: a file from a mounted fileable tree.
 */
export type RouteKind = "handler" | "static" | "src" | "redirect" | "mount";

export interface RouteEntry {
  /** URLPattern pathname syntax, Group prefixes included (`/users/:id`, `/static/*`). A Group's own `path="/"` route is listed at the prefix (`/users`). */
  path: string;
  /** Upper-case methods answered here (`["GET", "POST"]`); `["*"]` for a redirect, which answers any method. */
  methods: string[];
  kind: RouteKind;
  /** Named parameters in `path`, in order (`["id"]` for `/users/:id`). */
  params: string[];
  /** True when `path` isn't one literal URL: named parameters, wildcards or regexp groups. A UI can link straight to a route only when this is false. */
  hasParams: boolean;
  /** The joined `<Group>` prefix the route sits under, `""` for none. */
  prefix: string;
  /** For `kind: "redirect"`: where it points. */
  redirect?: string;
  /** For `kind: "redirect"`: its status (301 unless set; 302 for a mounted fileable symlink). */
  status?: number;
  /** True for a redirect made from a mounted fileable tree's symlink. Absent otherwise. */
  mounted?: boolean;
}

export interface HostEntry {
  /** A hostname, a URLPattern hostname pattern (`*.example.com`), or `*` for routes outside any `<Host>`. */
  hostname: string;
  /** True when `hostname` is a pattern rather than one literal name. */
  pattern: boolean;
  routes: RouteEntry[];
  /** Prefixes under this host with their own `<NotFound>` (`"/"` for the root). Empty when none. */
  notFoundPrefixes: string[];
}

/** A backend a gateway forwards to. servable apps have none; hostable fills these in for `<Upstream url=>`. */
export interface BackendEntry {
  /** The `<Host>` the `<Upstream>` is under, or `*`. */
  hostname: string;
  /** The path it's mounted at, Group prefixes included. */
  path: string;
  /** The `url=` it forwards to. */
  url: string;
  methods: string[];
}

export interface RoutesReport {
  hosts: HostEntry[];
  /** Always `[]` for a servable app; hostable lists `<Upstream url=>` backends here. */
  backends: BackendEntry[];
  /** True when any scope has a `<NotFound>`; false means unmatched requests get the generic `404 Not Found`. */
  notFound: boolean;
}

const isHostnamePattern = (hostname: string): boolean => hostname === "*" || /[*:(){}\\]/.test(hostname);

/** Named parameters in a URLPattern pathname. */
function paramNames(path: string): string[] {
  return [...path.matchAll(/(?<!\\):([\p{L}_$][\p{L}\p{N}_$]*)/gu)].map((m) => m[1]);
}

/** True when a URLPattern pathname matches more than one literal path. */
function patternHasParams(path: string): boolean {
  return /[:*(]/.test(path.replace(/\\./g, ""));
}

function routeKind(descriptor: Descriptor): RouteKind {
  if (mountedDescriptors.has(descriptor)) return "mount";
  if (descriptor.props.handler !== undefined) return "handler";
  if (descriptor.props.src !== undefined) return "src";
  return "static";
}

/** Lists what a laid-out app answers. Pure: reads `layout()`'s result, changes nothing. */
export function describeLayout(laidOut: LayoutResult): RoutesReport {
  const hosts = new Map<string, { routes: Map<string, RouteEntry>; notFoundPrefixes: string[] }>();
  const hostFor = (hostname: string) => {
    let host = hosts.get(hostname);
    if (!host) hosts.set(hostname, (host = { routes: new Map(), notFoundPrefixes: [] }));
    return host;
  };
  const entryFor = (hostname: string, key: string, make: () => RouteEntry): RouteEntry => {
    const { routes } = hostFor(hostname);
    let entry = routes.get(key);
    if (!entry) routes.set(key, (entry = make()));
    return entry;
  };

  for (const route of laidOut.routes) {
    const hostname = route.pattern.hostname && route.pattern.hostname !== "*" ? route.pattern.hostname : "*";
    const kind = routeKind(route.descriptor);
    const entry = entryFor(hostname, `${kind}:${route.path}`, () => ({
      path: route.path,
      methods: [],
      kind,
      params: paramNames(route.path),
      hasParams: patternHasParams(route.path),
      prefix: route.prefix,
    }));
    if (!entry.methods.includes(route.method)) entry.methods.push(route.method);
  }
  for (const redirect of laidOut.redirects) {
    const hostname = redirect.pattern.hostname && redirect.pattern.hostname !== "*" ? redirect.pattern.hostname : "*";
    const mounted = mountedDescriptors.has(redirect.descriptor);
    entryFor(hostname, `redirect:${redirect.from}`, () => ({
      path: redirect.from,
      methods: ["*"],
      kind: "redirect",
      params: paramNames(redirect.from),
      hasParams: patternHasParams(redirect.from),
      prefix: redirect.prefix,
      redirect: redirect.to,
      status: redirect.status,
      ...(mounted ? { mounted: true } : {}),
    }));
  }
  let notFound = false;
  for (const scope of laidOut.scopes) {
    if (!scope.notFoundHandler && !scope.notFoundStatic) continue;
    notFound = true;
    const prefixes = hostFor(scope.hostname ?? "*").notFoundPrefixes;
    const prefix = scope.prefix || "/";
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }

  return {
    hosts: [...hosts].map(([hostname, host]) => ({
      hostname,
      pattern: isHostnamePattern(hostname),
      routes: [...host.routes.values()],
      notFoundPrefixes: host.notFoundPrefixes,
    })),
    backends: [],
    notFound,
  };
}

/**
 * Lists what `tree` (an uncompiled servable tree) answers, running Build,
 * Resolve and Layout on a private copy. A compiled app has the same report
 * as `app.describeRoutes()` without running anything again; prefer that.
 */
export async function describeRoutes(tree: unknown, options: CompileOptions = {}): Promise<RoutesReport> {
  // layout() repopulates linkTo()'s registry; keep a live app's entries.
  const saved = [...linkRegistry];
  try {
    const roots = build(cloneDescriptorTree(tree));
    return describeLayout(layout(await resolveTree(roots, options)));
  } finally {
    linkRegistry.clear();
    for (const [descriptor, path] of saved) linkRegistry.set(descriptor, path);
  }
}
