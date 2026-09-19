/**
 * Merges multiple HeadersInit-shaped layers (Group defaults, Route/Response
 * overrides) into one real Headers instance -- never naive object-spread.
 * Two reasons that matters, both real bugs otherwise: HTTP header names are
 * case-insensitive (Headers.set() gets this right, `{...a,...b}` doesn't),
 * and Set-Cookie is legitimately repeatable (the one header the Fetch spec
 * itself special-cases for exactly this reason -- `.append()`, not
 * `.set()`). Every other header name uses `.set()` semantics: a later
 * layer's value for the same name overrides an earlier layer's, matching
 * how HTTP headers normally compose (Group's default Content-Type, say,
 * overridden by a specific Route).
 */
import type { HeadersInput, HeadersInputOrFn } from "./types.js";

const SET_COOKIE = "set-cookie";

function normalizeToEntries(input: HeadersInput): [string, string][] {
  if (input instanceof Headers) {
    return Array.from(input.entries());
  }
  if (Array.isArray(input)) {
    return input;
  }
  return Object.entries(input);
}

export function mergeHeadersInto(target: Headers, input: HeadersInput): void {
  for (const [name, value] of normalizeToEntries(input)) {
    if (name.toLowerCase() === SET_COOKIE) {
      target.append(name, value);
    } else {
      target.set(name, value);
    }
  }
}

/** Composes layers in order -- later layers override earlier ones (Set-Cookie always accumulates). */
export function mergeHeaders(...layers: HeadersInput[]): Headers {
  const merged = new Headers();
  for (const layer of layers) mergeHeadersInto(merged, layer);
  return merged;
}

export async function resolveHeadersInputOrFn(
  value: HeadersInputOrFn | undefined,
  req: Request,
): Promise<HeadersInput> {
  if (value === undefined) return new Headers();
  if (typeof value === "function") return value(req);
  return value;
}
