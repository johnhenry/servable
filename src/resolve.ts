/**
 * Node/full build of resolve-core.ts's Stage 2 walk -- adds the two
 * genuinely Node-only capabilities on top of it: expanding a `<Group from>`
 * glob pattern/file list (via the `glob` package) and dynamically
 * `import()`-ing matched handler files / a `<Route handler="./mod.js">`
 * string path (via `node:url`'s `pathToFileURL` + `node:path`). Resolved
 * automatically via this package's `#resolve` internal import (see
 * package.json's `imports` field) whenever a bundler/runtime doesn't
 * explicitly resolve the `"browser"` condition -- see #5.
 */
import { extname, isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "glob";
import { isThenable, ServableError } from "./types.js";
import type { Descriptor } from "./types.js";
import { splitGlobBase, toPosixPattern } from "./glob-util.js";
import { createResolve } from "./resolve-core.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function isThenableArray(value: unknown): value is Promise<string[]> {
  return isThenable(value);
}

async function resolveFromGlobPattern(
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
async function synthesizeRoutesFromFile(absolute: string, routePath: string, path: string): Promise<Descriptor[]> {
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

export const resolve = createResolve({
  defaultBaseDir: () => process.cwd(),

  async resolveGlobFrom(fromValue, baseDir, path) {
    const matches = await resolveFromGlobPattern(fromValue, baseDir, path);
    // Resolved to an absolute path up front so this is correct whether the
    // original pattern was relative or already absolute -- mixing an
    // absolute `patternBase` against a relative match (or vice versa) made
    // the old startsWith-based prefix check silently fail and collapse
    // every match to a bare basename, found by actually running this
    // against an absolute glob pattern.
    const patternBase = typeof fromValue === "string" ? splitGlobBase(toPosixPattern(fromValue)).base : "";
    const absoluteBase = patternBase ? resolvePath(baseDir, patternBase) : baseDir;
    const synthesized: Descriptor[] = [];
    for (const match of matches) {
      const relativeToBase = toPosixPattern(relativePath(absoluteBase, match));
      const withoutExt = relativeToBase.slice(0, relativeToBase.length - extname(match).length);
      const routePath = `/${withoutExt}`;
      synthesized.push(...(await synthesizeRoutesFromFile(match, routePath, path)));
    }
    return synthesized;
  },

  async resolveStringHandler(handler, baseDir, path) {
    const absolute = isAbsolute(handler) ? handler : resolvePath(baseDir, handler);
    const mod = await loadHandlerModule(absolute, path);
    if (typeof mod.default !== "function") {
      throw new ServableError(`handler module "${handler}" has no default export function`, path);
    }
    return mod.default;
  },
});
