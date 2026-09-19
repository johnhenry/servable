/**
 * Shared between layout.ts (writer) and api.ts's linkTo() (reader).
 *
 * linkTo() has two callers with different timing:
 *  - called while a JSX tree is being *authored* (embedded in static markup
 *    children, e.g. `<a href={linkTo(usersRoute)}>`) -- this always happens
 *    *before* compile() runs on that tree, so the registry is empty/stale
 *    for it; linkTo() returns a LinkRef marker for Layout to substitute.
 *  - called *inside* a handler function's body -- handlers only run
 *    per-request, long after the compile() call that will serve them has
 *    already finished and populated this registry; linkTo() returns the
 *    resolved path string directly, synchronously.
 *
 * Known limitation: this is a single module-level registry, so calling
 * compile() a second time (on a different tree) while a *previous* compiled
 * dispatcher is still serving live requests whose handlers call linkTo()
 * will corrupt those in-flight lookups -- no hot-reload/live-recompile
 * story exists in v1 (an explicit non-goal), so this isn't handled.
 */
import type { Descriptor } from "./types.js";

export const linkRegistry = new Map<Descriptor, string>();
