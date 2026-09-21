/**
 * servable's own JSX runtime -- selected via a per-file
 * `@jsxImportSource @johnhenry/servable` pragma or
 * `compilerOptions.jsxImportSource`. No React/Solid/Astro runtime involved:
 * structural tags become descriptor nodes; everything else (plain markup
 * tags, function components) is evaluated immediately, mirroring the JSX
 * call tree 1:1. Normalization happens in the Build stage (`build.ts`), not
 * here -- same split as fileable's jsx-runtime.ts.
 *
 * `router`/`group`/`route`/`use`/`errorboundary`/`notfound`/`redirect`/
 * `response` are reserved and NOT treated as structural when written as bare
 * lowercase tags -- authoring them directly throws. `Router`/`Group`/
 * `Route`/`Use`/`ErrorBoundary`/`NotFound`/`Redirect`/`Response`, imported
 * from "@johnhenry/servable" (see `components.ts`), are the only supported
 * way to reach the eight primitives.
 */
import type { Descriptor, DescriptorChild, Tag } from "./types.js";
import { FRAGMENT, ServableError } from "./types.js";

export const Fragment = FRAGMENT;

type ComponentFn = (props: Record<string, unknown>) => unknown;

const RESERVED_TAGS: Record<string, string> = {
  router: "Router",
  group: "Group",
  host: "Host",
  route: "Route",
  use: "Use",
  errorboundary: "ErrorBoundary",
  notfound: "NotFound",
  redirect: "Redirect",
  response: "Response",
};

function toChildArray(children: unknown): DescriptorChild[] {
  if (children === undefined) return [];
  return ([] as DescriptorChild[]).concat(children as DescriptorChild);
}

export function jsx(
  type: Tag | ComponentFn,
  props: (Record<string, unknown> & { children?: unknown }) | null,
): Descriptor {
  const allProps = props ?? {};
  if (typeof type === "function") {
    return type(allProps) as Descriptor;
  }
  if (typeof type === "string" && type in RESERVED_TAGS) {
    const component = RESERVED_TAGS[type];
    throw new ServableError(
      `<${type}> is reserved and not a servable primitive on its own -- ` +
        `import { ${component} } from "@johnhenry/servable" and write <${component}> instead of the bare lowercase tag`,
      `<${type}>`,
    );
  }
  const { children, ...rest } = allProps;
  const descriptor: Descriptor = {
    tag: type,
    props: rest,
    children: toChildArray(children),
  };
  return descriptor;
}

// The "automatic" JSX transform calls jsxs() instead of jsx() when there is
// more than one statically-known child; behavior is otherwise identical.
export const jsxs = jsx;

export namespace JSX {
  interface CommonProps {
    [key: string]: unknown;
    children?: unknown;
  }
  export interface IntrinsicElements {
    [elemName: string]: CommonProps;
  }
  export type Element = Descriptor;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
}
