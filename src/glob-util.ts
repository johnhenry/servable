/**
 * The `glob` package requires forward-slash patterns even on Windows --
 * passing an OS-native (backslash) path as a pattern silently matches
 * nothing rather than erroring. Mirrors fileable's src/glob-util.ts.
 */
export function toPosixPattern(pattern: string): string {
  return pattern.replace(/\\/g, "/");
}

/**
 * Splits a glob pattern into its fixed directory prefix and the remaining
 * glob-bearing suffix, e.g. "handlers/**\/*.js" -> { base: "handlers", rest:
 * "**\/*.js" }. Used to preserve `<Group from>`'s matched files' relative
 * subdirectory structure instead of flattening them to a bare basename.
 */
export function splitGlobBase(pattern: string): { base: string; rest: string } {
  const specialIndex = pattern.search(/[*?{[]/);
  if (specialIndex === -1) return { base: "", rest: pattern };
  const slashIndex = pattern.lastIndexOf("/", specialIndex);
  if (slashIndex === -1) return { base: "", rest: pattern };
  return { base: pattern.slice(0, slashIndex), rest: pattern.slice(slashIndex + 1) };
}
