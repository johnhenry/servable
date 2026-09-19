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

/** Compiles a `path` string (or passes through an already-constructed URLPattern) into one. */
export function compilePath(path: string | InstanceType<URLPatternCtor>): InstanceType<URLPatternCtor> {
  if (typeof path !== "string") return path;
  // Bare pathname pattern -- match any origin, so a relative "/users/:id"
  // works the same whether the incoming Request's URL is
  // "http://localhost/users/1" or "https://example.com/users/1".
  return new URLPatternImpl({ pathname: path });
}
