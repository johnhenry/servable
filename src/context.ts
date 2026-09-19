/**
 * servable is a build-time-compile, then long-running-dispatch tool. Warnings
 * collected during compile() (e.g. an unsupported artifact skipped while
 * mounting a fileable tree) are drained once, after Compile completes --
 * same module-level-singleton shape as fileable's context.ts.
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
