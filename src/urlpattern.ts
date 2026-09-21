/**
 * URLPattern isn't a global in Node 18/20/22 (fileable's own supported
 * matrix) -- ship `urlpattern-polyfill` as a real dependency so `path`
 * string compilation works identically everywhere, but prefer a native
 * global when one exists (Deno/Bun/Cloudflare Workers/newer Node don't need
 * the polyfill). Never require the consumer to add the polyfill themselves.
 */
import { URLPattern as URLPatternPolyfill } from "urlpattern-polyfill";

type URLPatternCtor = typeof URLPatternPolyfill;

const NativeURLPattern = (globalThis as { URLPattern?: URLPatternCtor }).URLPattern;

export const URLPatternImpl: URLPatternCtor = NativeURLPattern ?? URLPatternPolyfill;

/**
 * The type of whatever URLPatternImpl actually resolves to at runtime
 * (native or polyfilled) -- used everywhere `path` is typed, instead of the
 * ambient global `URLPattern` (from lib.dom.d.ts), since the polyfill's own
 * type doesn't structurally match it exactly (e.g. `hasRegExpGroups`) and a
 * consumer's native global could be either depending on their Node version.
 */
export type URLPatternInstance = InstanceType<URLPatternCtor>;

/**
 * Compiles a `path` string (or passes through an already-constructed
 * URLPattern unchanged) into one. `hostname`, when given, is a `<Host>`
 * scope's own hostname-pattern-syntax value (an exact hostname, or a
 * URLPattern hostname pattern like `"*.example.com"`) -- baked directly
 * into the same URLPattern instance's `hostname` component, so a single
 * `pattern.exec(req.url)` (the dispatch loop's own matching, unchanged)
 * naturally checks both hostname and pathname together, and naturally
 * `continue`s to the next candidate route when only one of the two
 * matches (see layout.ts's `WalkCtx.hostname`/compile.ts's dispatch loop).
 * Omitted (undefined): match any origin, same as before `<Host>` existed
 * -- a relative "/users/:id" pattern works the same whether the incoming
 * Request's URL is "http://localhost/users/1" or "https://example.com/users/1".
 */
export function compilePath(path: string | InstanceType<URLPatternCtor>, hostname?: string): InstanceType<URLPatternCtor> {
  if (typeof path !== "string") return path;
  return hostname === undefined ? new URLPatternImpl({ pathname: path }) : new URLPatternImpl({ hostname, pathname: path });
}
