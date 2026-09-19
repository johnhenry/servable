/**
 * Dev-mode JSX entry point. servable performs no reconciliation/diffing, so
 * there is nothing extra to instrument in dev mode -- this just re-exports
 * the production runtime under the names the "jsxDEV" transform expects.
 */
export { Fragment, jsx, jsx as jsxDEV, jsxs } from "./jsx-runtime.js";
export type { JSX } from "./jsx-runtime.js";
