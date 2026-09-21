/**
 * Core descriptor tree types shared by every pipeline stage (Build -> Resolve ->
 * Layout -> Compile). Mirrors fileable's src/types.ts shape (Descriptor,
 * DescriptorChild, the clone/guard helpers) applied to a different domain:
 * an HTTP dispatcher instead of a filesystem tree.
 */
import type { URLPatternInstance } from "./urlpattern.js";

export const FRAGMENT: unique symbol = Symbol.for("servable.fragment");

export type StructuralTag =
  | "router"
  | "group"
  | "host"
  | "route"
  | "use"
  | "errorboundary"
  | "notfound"
  | "redirect"
  | "response";

export interface BaseProps {
  [key: string]: unknown;
  children?: unknown;
}

/** Route params extracted from a URLPattern match (its `groups` object, unmodified). */
export type RouteParams = Record<string, string | undefined>;

export interface RouteContext {
  params: RouteParams;
}

export type Handler = (req: Request, ctx: RouteContext) => Response | Promise<Response>;
export type NextFn = () => Promise<Response>;
export type Middleware = (req: Request, ctx: RouteContext, next: NextFn) => Response | Promise<Response>;
export type ErrorHandler = (error: unknown, req: Request, ctx: RouteContext) => Response | Promise<Response>;

/** Same union the Fetch API's own HeadersInit already defines -- see api.ts's mergeHeaders. */
export type HeadersInput = Headers | Record<string, string> | [string, string][];
export type HeadersInputOrFn = HeadersInput | ((req: Request) => HeadersInput | Promise<HeadersInput>);
export type TrailersInputOrFn = HeadersInput | ((body: unknown) => HeadersInput | Promise<HeadersInput>);

export interface RouterProps extends BaseProps {}

/**
 * The minimal structural shape of a fileable Descriptor -- deliberately not
 * servable's own (nominally different) Descriptor type, since fileable's
 * own `Tag` union includes its own `unique symbol` fragment marker that
 * doesn't structurally match servable's. mount-fileable.ts only ever
 * duck-types this shape at runtime (never imports fileable's types), so the
 * type here shouldn't force a hard dependency either.
 */
export interface FileableTreeLike {
  tag: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

/**
 * A hostname-axis scope -- matched against the incoming request's own
 * Host header (via `new URL(req.url).hostname`, already how the Node
 * adapter builds a Request's URL). Compiles into the same `URLPattern`
 * `hostname` component every nested `Route`/`Redirect`'s own compiled
 * pattern carries (see layout.ts's `WalkCtx.hostname`) -- a real Layout-
 * stage scope, applied AFTER every other pipeline stage has finished
 * expanding the tree (mounted fileable trees, glob-based file routing,
 * promise-valued `path`s, ...), unlike a pre-Build tree rewrite, which can
 * only see nodes that already exist at rewrite time. `name` (an exact
 * hostname) and `pattern` (URLPattern hostname-pattern syntax, e.g.
 * `"*.example.com"`) are mutually exclusive -- exactly one is required.
 */
export interface HostProps extends BaseProps {
  name?: string;
  pattern?: string;
}

export interface GroupProps extends BaseProps {
  prefix?: string;
  /**
   * A glob pattern (file-based routing, one Route per matched handler
   * module) or a fileable Descriptor tree (mount its artifacts as static
   * routes -- detected by duck-typing the same {tag,props,children} shape
   * fileable's own isDescriptor uses, see mount-fileable.ts).
   */
  from?: string | Promise<string[]> | string[] | FileableTreeLike;
  headers?: HeadersInputOrFn;
}

export type SrcValue = string | Blob;
export type SrcProp = SrcValue | ((req: Request, ctx: RouteContext) => SrcValue | Promise<SrcValue>);

export interface RouteProps extends BaseProps {
  path?: string | URLPatternInstance;
  method?: string;
  handler?: Handler | string;
  src?: SrcProp;
  download?: boolean | string;
  headers?: HeadersInputOrFn;
  trailers?: TrailersInputOrFn;
}

export interface UseProps extends BaseProps {
  middleware?: Middleware;
}

export interface ErrorBoundaryProps extends BaseProps {
  handler?: ErrorHandler;
}

export interface NotFoundProps extends BaseProps {
  handler?: Handler;
}

export interface RedirectProps extends BaseProps {
  from?: string;
  to?: string;
  status?: number;
}

export interface ResponseTagProps extends BaseProps {
  status?: number;
  headers?: HeadersInputOrFn;
  trailers?: TrailersInputOrFn;
}

/**
 * Any tag that isn't one of the eight structural primitives is plain
 * markup. Widened to the general `symbol` type (not the exact `typeof
 * FRAGMENT`) so a sibling package's own JSX runtime -- which necessarily
 * has its own, differently-keyed Fragment symbol -- can type-check its
 * `Descriptor` as a valid servable JSX element when its components (e.g.
 * fileable's `<Dir>`/`<File>`) are nested directly inside `<Router>`/
 * `<Group>`. See "Mounting without from=" below -- both runtimes already
 * called function-typed tags directly at runtime; this only removes a
 * false type error.
 */
export type Tag = StructuralTag | symbol | string;

export interface Descriptor {
  tag: Tag;
  props: Record<string, unknown>;
  children: DescriptorChild[];
  /** Assigned by the Build stage; stable identity for linkTo() lookups. */
  __id?: string;
}

/**
 * Unlike fileable (where children must eventually be textual/binary file
 * content), a Route's static children can be any recognized BodyInit-shaped
 * value or a plain object (-> JSON) -- `object` covers those without
 * enumerating each one; `compile.ts`'s `resolveStaticChildren` is what
 * actually interprets the value.
 */
export type DescriptorChild =
  | Descriptor
  | LinkRef
  | string
  | number
  | boolean
  | object
  | null
  | undefined
  | DescriptorChild[];

export function isDescriptor(value: unknown): value is Descriptor {
  return (
    !!value &&
    typeof value === "object" &&
    "tag" in (value as object) &&
    "props" in (value as object) &&
    "children" in (value as object)
  );
}

// A global-symbol-registry key, not an import -- `Symbol.for("fileable.descriptor")`
// resolves to the exact same symbol `@johnhenry/fileable` stamps onto every
// descriptor it creates (see its src/types.ts), with zero coupling to that
// package's module graph. `@johnhenry/fileable` is an *optional* peer
// dependency; a real import here would defeat the point of it being lazy.
// Lives here (not in mount-fileable.ts, which is where it's mainly used)
// so `cloneDescriptorTree`, below, can check it too without a circular
// import -- `isDescriptor` alone can't tell a fileable descriptor apart
// from a servable one (both packages produce the identical
// {tag,props,children} shape), which matters here specifically because
// cloneNode reconstructs a plain {tag,props,children} object field by
// field and would otherwise silently strip this exact symbol-keyed brand.
const FILEABLE_DESCRIPTOR = Symbol.for("fileable.descriptor");

export function isFileableDescriptor(value: unknown): value is FileableTreeLike {
  return !!value && typeof value === "object" && FILEABLE_DESCRIPTOR in value;
}

/**
 * linkTo() cannot resolve its target synchronously -- Layout, which owns the
 * final route table, runs after Build/Resolve. It returns this marker
 * instead; Layout substitutes every LinkRef with its final path string once
 * every route's method+pattern is known. Same mechanism as fileable's
 * LinkRef, applied to route paths instead of filesystem paths.
 */
export interface LinkRef {
  readonly __servableRef: "link";
  target: Descriptor | string;
}

export function isLinkRef(value: unknown): value is LinkRef {
  return !!value && typeof value === "object" && (value as { __servableRef?: string }).__servableRef === "link";
}

export function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof value === "object" && typeof (value as Promise<unknown>).then === "function";
}

/**
 * Deep-clones a descriptor/LinkRef/array structure, preserving internal
 * identity relationships, so calling compile() twice on the same tree
 * object never lets one call's mutations (Build assigns __id, Resolve
 * imports handler modules) leak into the next -- same class of bug
 * fileable's render() had before it started cloning up front.
 */
export function cloneDescriptorTree<T>(root: T): T {
  return cloneNode(root, new WeakMap<object, unknown>()) as T;
}

function cloneNode(value: unknown, memo: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  const cached = memo.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    memo.set(value, cloned);
    for (const item of value) cloned.push(cloneNode(item, memo));
    return cloned;
  }
  // Opaque, by reference -- reconstructing it field-by-field the way a
  // servable descriptor is cloned below would silently drop the
  // FILEABLE_DESCRIPTOR brand (a plain {tag,props,children} object literal
  // has no reason to carry an unrelated package's symbol-keyed property),
  // and would apply servable's own clone semantics to what's actually
  // fileable's internal content. Mounting (mountFileableTree) runs
  // fileable's own pipeline on it fresh later and never mutates its input,
  // so cloning it here has no purpose anyway.
  if (isDescriptor(value) && isFileableDescriptor(value)) {
    return value;
  }
  if (isDescriptor(value)) {
    const cloned: Descriptor = { tag: value.tag, props: {}, children: [] };
    memo.set(value, cloned);
    for (const [key, propValue] of Object.entries(value.props)) {
      cloned.props[key] = cloneNode(propValue, memo);
    }
    cloned.children = value.children.map((child) => cloneNode(child, memo)) as DescriptorChild[];
    return cloned;
  }
  if (isLinkRef(value)) {
    const cloned: LinkRef = { __servableRef: "link", target: value.target };
    memo.set(value, cloned);
    cloned.target = cloneNode(value.target, memo) as Descriptor | string;
    return cloned;
  }
  return value; // opaque (Blob, Request, function, ...) -- keep by reference
}

export class ServableError extends Error {
  path: string;
  constructor(message: string, path: string, cause?: unknown) {
    super(`${message} (at ${path})`);
    this.name = "ServableError";
    this.path = path;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export interface CompileOptions {
  /** Base directory used to resolve relative `handler`/`src` module paths. Default: cwd. */
  cwd?: string;
  /**
   * EXAMPLE: base URL an `ipfs://<cid>/<path>` `Route`/`serveFile()` `src`
   * resolves against -- `ipfs://<cid>/<path>` becomes
   * `${ipfsGateway}${cid}/${path}`. Default: `"https://ipfs.io/ipfs/"`.
   * Mirrors `@johnhenry/fileable`'s own `RenderOptions.ipfsGateway` --
   * same idea, same default, independently implemented at this layer
   * since `Route src` is resolved fresh per-request (serve-file.ts), not
   * once at compile time the way fileable's own `src` is.
   */
  ipfsGateway?: string;
}

/** The compiled artifact: one dispatcher function, plus warnings collected along the way. */
export interface CompileResult {
  fetch: (req: Request) => Promise<Response>;
  warnings: string[];
}
