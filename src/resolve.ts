/**
 * Stage 2: Resolve.
 *
 * Walks the full tree and resolves everything that needs async work:
 *  - `<Group from="glob">` expansion into synthesized `<Route>` children
 *    (file-based routing) -- mirrors fileable's `<Dir from>`, including
 *    preserving matched files' relative subdirectory structure instead of
 *    flattening to a bare basename.
 *  - `<Group from={fileableTree}>` -- mounts a fileable Descriptor tree's
 *    artifacts as static routes (see mount-fileable.ts), lazily importing
 *    `@johnhenry/fileable` only when this is actually used.
 *  - `handler="./mod.js"` (import a module, its default export is the handler)
 *  - any other Promise-valued prop, generically
 *
 * Errors are wrapped with the offending node's tree path before propagating,
 * same as fileable's resolve.ts.
 */
import { extname, isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "glob";
import { isDescriptor, isLinkRef, isThenable, ServableError } from "./types.js";
import type { CompileOptions, Descriptor, DescriptorChild } from "./types.js";
import { splitGlobBase, toPosixPattern } from "./glob-util.js";
import { mountFileableTree, looksLikeFileableDescriptor } from "./mount-fileable.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function isThenableArray(value: unknown): value is Promise<string[]> {
  return isThenable(value);
}

async function resolveFromGlob(
  pattern: string | Promise<string[]> | string[],
  baseDir: string,
  path: string,
): Promise<string[]> {
  if (Array.isArray(pattern)) return pattern;
  if (isThenableArray(pattern)) {
    try {
      return await pattern;
    } catch (cause) {
      throw new ServableError("`from` promise rejected", path, cause);
    }
  }
  try {
    return await glob(toPosixPattern(pattern), { cwd: baseDir, absolute: true, nodir: true });
  } catch (cause) {
    throw new ServableError(`\`from\` glob expansion failed for "${pattern}"`, path, cause);
  }
}

async function loadHandlerModule(absolute: string, path: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new ServableError(
      `failed to import handler module "${absolute}" -- .jsx/.tsx handlers must already be ` +
        "compiled to JS (or loadable via a registered Node loader) before compile() runs",
      path,
      cause,
    );
  }
}

/** One matched handler file -> one Route per exported HTTP-method handler, or one GET Route for a plain default export. */
async function synthesizeRoutesFromFile(
  absolute: string,
  routePath: string,
  path: string,
): Promise<Descriptor[]> {
  const mod = await loadHandlerModule(absolute, path);
  const methodExports = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
  if (methodExports.length > 0) {
    return methodExports.map((method) => ({
      tag: "route",
      props: { path: routePath, method, handler: mod[method] },
      children: [],
    }));
  }
  if (typeof mod.default === "function") {
    return [{ tag: "route", props: { path: routePath, method: "GET", handler: mod.default }, children: [] }];
  }
  throw new ServableError(
    `handler module "${absolute}" has no default export and no named export matching an HTTP method (${HTTP_METHODS.join("/")})`,
    path,
  );
}

export async function resolve(roots: Descriptor[], options: CompileOptions = {}): Promise<Descriptor[]> {
  const baseDir = options.cwd ?? process.cwd();

  async function resolveNode(node: Descriptor, path: string): Promise<void> {
    if (node.tag === "group" && node.props.from !== undefined) {
      const fromValue = node.props.from;
      if (looksLikeFileableDescriptor(fromValue)) {
        const mounted = await mountFileableTree(fromValue, path);
        node.children = [...mounted, ...node.children];
      } else {
        const pattern = fromValue as string | Promise<string[]> | string[];
        const matches = await resolveFromGlob(pattern, baseDir, path);
        // Resolved to an absolute path up front so this is correct whether
        // the original pattern was relative or already absolute -- mixing
        // an absolute `patternBase` against a relative match (or vice
        // versa) made the old startsWith-based prefix check silently fail
        // and collapse every match to a bare basename, found by actually
        // running this against an absolute glob pattern.
        const patternBase = typeof pattern === "string" ? splitGlobBase(toPosixPattern(pattern)).base : "";
        const absoluteBase = patternBase ? resolvePath(baseDir, patternBase) : baseDir;
        const synthesized: Descriptor[] = [];
        for (const match of matches) {
          const relativeToBase = toPosixPattern(relativePath(absoluteBase, match));
          const withoutExt = relativeToBase.slice(0, relativeToBase.length - extname(match).length);
          const routePath = `/${withoutExt}`;
          synthesized.push(...(await synthesizeRoutesFromFile(match, routePath, path)));
        }
        node.children = [...synthesized, ...node.children];
      }
    }

    if (node.tag === "route") {
      const handler = node.props.handler;
      if (typeof handler === "string") {
        const absolute = isAbsolute(handler) ? handler : resolvePath(baseDir, handler);
        const mod = await loadHandlerModule(absolute, path);
        if (typeof mod.default !== "function") {
          throw new ServableError(`handler module "${handler}" has no default export function`, path);
        }
        node.props.handler = mod.default;
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

    for (const child of node.children) {
      await resolveChild(child, `${path} > ${String(node.tag)}`);
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
}
