export { compile } from "./compile.js";
export { linkTo, warn, markdownToHtml, setCookie, sse, streamBody, upgradeWebSocket, serveFile } from "./api.js";
export { Router, Group, Host, Route, Use, ErrorBoundary, NotFound, Redirect, Response } from "./components.js";

// Individual stages are exported too so each can be tested independently,
// same PRD-derived framing as fileable's index.ts.
export { build } from "./build.js";
export { resolve } from "#resolve";
export { layout } from "./layout.js";

// Exposed so a caller that inspects a compiled/resolved tree (e.g. to draw
// a route table, per issue #9) can get its own safe copy without mutating
// the original -- compile() already relies on this internally to clone the
// input tree before Build ever sees it.
export { cloneDescriptorTree } from "./types.js";

export type {
  CookieOptions,
  ServeFileOptions,
  SseEvent,
} from "./api.js";
export type {
  BaseProps,
  CompileOptions,
  CompileResult,
  Descriptor,
  DescriptorChild,
  ErrorBoundaryProps,
  ErrorHandler,
  GroupProps,
  Handler,
  HeadersInput,
  HeadersInputOrFn,
  HostProps,
  Middleware,
  NextFn,
  NotFoundProps,
  RedirectProps,
  ResponseTagProps,
  RouteContext,
  RouteParams,
  RouteProps,
  RouterProps,
  SrcProp,
  SrcValue,
  TrailersInputOrFn,
  UseProps,
} from "./types.js";
export { ServableError } from "./types.js";
// Type-only, so importing straight from resolve-core.ts (bypassing the
// #resolve browser/default self-import split) is safe -- both
// resolve.ts's and resolve.browser.ts's `resolve` share this exact shape,
// and the type itself is erased at compile time regardless of which one a
// given build resolves to.
export type { ResolvedRoots } from "./resolve-core.js";
