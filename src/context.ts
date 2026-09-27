/**
 * Backs ONLY the public `warn()` API (api.ts) -- a deliberately global,
 * fire-and-forget escape hatch arbitrary user code can call at any time
 * (mirroring fileable's own `warn()`/context.ts, including its accepted
 * "shared across independent calls in the same process" limitation), not
 * tied to any particular pipeline stage.
 *
 * Warnings raised BY a pipeline stage itself (currently: mounting a
 * fileable tree, see mount-fileable.ts) are deliberately NOT routed through
 * here -- they're returned directly from resolve()'s own per-call result
 * (resolve-core.ts's `ResolvedRoots.warnings`) and aggregated by compile().
 * Before this split, mount-fileable's warnings went through this same
 * module-global accumulator, which only compile() ever cleared -- so
 * calling resolve() (or build()/layout()) directly, without going through
 * compile(), left warnings sitting here indefinitely; the next unrelated
 * compile() call would then report them AGAIN on top of its own, with the
 * total depending on whatever independently-called pipeline stage happened
 * to run earlier in the same process (issue #9).
 */
const state = { warnings: [] as string[] };

export function recordWarning(message: string): void {
  state.warnings.push(message);
}

export function drainWarnings(): string[] {
  const warnings = state.warnings.slice();
  state.warnings.length = 0;
  return warnings;
}
