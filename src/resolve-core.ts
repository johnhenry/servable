/**
 * Stage 2: Resolve -- shared tree-walking core.
 *
 * Walks the full tree and resolves everything that needs async work:
 *  - `<Group from="glob">` / `<Group from={[...]}>` / `<Group from={Promise<[...]>}>`
 *    expansion into synthesized `<Route>` children (file-based routing) --
 *    genuinely Node-only (glob expansion + dynamic `import()` of matched
 *    handler files by path), factored out behind `resolveGlobFrom` below.
 *  - `<Group from={fileableTree}>` -- mounts a fileable Descriptor tree's
 *    artifacts as static routes (see mount-fileable.ts), lazily importing
 *    `@johnhenry/fileable` only when this is actually used. Pure string/tree
 *    manipulation, no filesystem access of its own -- browser-safe.
 *  - `handler="./mod.js"` (import a module, its default export is the
 *    handler) -- genuinely Node-only, factored out behind
 *    `resolveStringHandler` below.
 *  - any other Promise-valued prop, generically -- browser-safe.
 *
 * Errors are wrapped with the offending node's tree path before propagating,
 * same as fileable's resolve.ts.
 *
 * SPLIT (see #5): this file itself imports no Node built-ins and is used by
 * BOTH resolve.ts (the default/Node build, real glob + dynamic import) and
 * resolve.browser.ts (used automatically when a bundler resolves the
 * `"browser"` condition, where those two operations throw a clear,
 * actionable error instead of failing on a bundler's empty `node:path`/
 * `node:url`/`glob` stubs) -- same walking logic either way, only the two
 * genuinely-filesystem-dependent operations are swapped via these hooks.
 */
import { isDescriptor, isFileableDescriptor, isLinkRef, isThenable, ServableError } from "./types.js";
import type { CompileOptions, Descriptor, DescriptorChild } from "./types.js";
import { mountFileableTree } from "./mount-fileable.js";

export interface ResolveHooks {
  /** `options.cwd` when the caller doesn't supply one -- `process.cwd()` in Node, `""` in the browser-safe build (never actually read there, since both hooks below always throw). */
  defaultBaseDir(): string;
  /**
   * Resolves a `<Group from>` value that isn't a fileable descriptor --
   * a glob pattern string, an explicit `string[]` of absolute file paths,
   * or a `Promise<string[]>` of one -- into synthesized `<Route>`
   * descriptors (one per matched handler file's exported HTTP-method
   * functions, or a single GET route for a plain default export).
   */
  resolveGlobFrom(
    fromValue: string | Promise<string[]> | string[],
    baseDir: string,
    path: string,
  ): Promise<Descriptor[]>;
  /** Resolves `<Route handler="./mod.js">` into the imported module's default export function. */
  resolveStringHandler(handler: string, baseDir: string, path: string): Promise<unknown>;
}

export function createResolve(hooks: ResolveHooks): (roots: Descriptor[], options?: CompileOptions) => Promise<Descriptor[]> {
  return async function resolve(roots: Descriptor[], options: CompileOptions = {}): Promise<Descriptor[]> {
    const baseDir = options.cwd ?? hooks.defaultBaseDir();

    async function resolveNode(node: Descriptor, path: string): Promise<void> {
      if (node.tag === "group" && node.props.from !== undefined) {
        const fromValue = node.props.from;
        if (isFileableDescriptor(fromValue)) {
          const mounted = await mountFileableTree(fromValue, path);
          node.children = [...mounted, ...node.children];
        } else {
          const synthesized = await hooks.resolveGlobFrom(fromValue as string | Promise<string[]> | string[], baseDir, path);
          node.children = [...synthesized, ...node.children];
        }
      }

      if (node.tag === "route") {
        const handler = node.props.handler;
        if (typeof handler === "string") {
          node.props.handler = await hooks.resolveStringHandler(handler, baseDir, path);
        }
      }

      // Generic fallback: any other promise-valued prop (future-proofing).
      for (const [key, value] of Object.entries(node.props)) {
        if (key === "from" || key === "handler") continue;
        if (isThenable(value)) {
          try {
            node.props[key] = await value;
          } catch (cause) {
            throw new ServableError(`prop "${key}" promise rejected`, path, cause);
          }
        }
      }

      // A fileable descriptor (<Dir>/<File>/<Rm>, or generic markup nested
      // under one) placed directly as a child of <Router>/<Group>/<Host> --
      // not just behind `from=` -- is mounted the same way `from={fileableTree}`
      // is. Scoped to router/group/host (the containment/scope primitives)
      // rather than every node, since e.g. a Route's children are a *static
      // value* slot, a different semantic than "nested primitives" -- mixing
      // the two would make an accidental fileable descriptor in a Route's
      // content silently ambiguous instead of clearly out of scope. <Host> is
      // included so a fileable tree mounted directly under a Host (no Group
      // wrapper) is hostname-qualified by Layout exactly like a literal
      // <Route> would be -- the whole point of Host now being a real Layout-
      // stage scope, not a pre-Build rewrite that could only qualify nodes it
      // could already see (see layout.ts's own module doc comment).
      const childPath = `${path} > ${String(node.tag)}`;
      if (node.tag === "router" || node.tag === "group" || node.tag === "host") {
        const resolvedChildren: DescriptorChild[] = [];
        for (const child of node.children) {
          if (isDescriptor(child) && isFileableDescriptor(child)) {
            resolvedChildren.push(...(await mountFileableTree(child, childPath)));
            continue;
          }
          await resolveChild(child, childPath);
          resolvedChildren.push(child);
        }
        node.children = resolvedChildren;
      } else {
        for (const child of node.children) {
          // A fileable descriptor outside router/group scope used to fail
          // silently and confusingly: compile.ts's resolveStaticChildren has
          // no idea what a <File>/<Dir> means, so it fell into the generic
          // "JSX markup -> HTML" path and serialized the descriptor's own
          // {tag,props,children} shape as literal tag text (e.g. a Route's
          // response body became the literal string
          // `<file name="x.html">content</file>`) -- wrong output, no error,
          // discovered only by actually inspecting a response body. Caught
          // here instead, at compile time, with an actionable message.
          if (isDescriptor(child) && isFileableDescriptor(child)) {
            throw new ServableError(
              `a fileable <${String(child.tag)}> descriptor can't be used here, under <${String(node.tag)}> -- ` +
                "fileable descriptors are only mounted as static routes when they're a direct child of " +
                "<Router>/<Group>/<Host> (or a Group's own from= prop). For a single file's content at one Route, " +
                "use that Route's own body handling (a string/Response/BodyInit/object child) or its src= prop " +
                "instead of fileable's <File>.",
              childPath,
            );
          }
          await resolveChild(child, childPath);
        }
      }
    }

    async function resolveChild(child: DescriptorChild, path: string): Promise<void> {
      if (isDescriptor(child)) {
        await resolveNode(child, path);
      } else if (Array.isArray(child)) {
        for (const item of child) await resolveChild(item, path);
      } else if (isLinkRef(child) && isDescriptor(child.target)) {
        // Target descriptors are resolved in place wherever they live in the tree.
      }
    }

    for (const root of roots) {
      await resolveNode(root, String(root.tag));
    }
    return roots;
  };
}
