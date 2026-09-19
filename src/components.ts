/**
 * The only supported way to reach the eight structural primitives.
 * `<Router>`/`<Group>`/`<Route>`/`<Use>`/`<ErrorBoundary>`/`<NotFound>`/
 * `<Redirect>`/`<Response>` (or called directly as functions, no JSX needed)
 * are ordinary functions with an explicit, importable identity -- unlike the
 * lowercase `<router>`/`<group>`/etc. tags, which are reserved and throw if
 * authored directly (see jsx-runtime.ts's RESERVED_TAGS). These build the
 * descriptor directly rather than going through `jsx()`, since `jsx()` is
 * exactly where that lowercase-tag rejection lives -- these three are the
 * sanctioned bypass, not a loophole (mirrors fileable's components.ts).
 */
import type {
  Descriptor,
  DescriptorChild,
  ErrorBoundaryProps,
  GroupProps,
  NotFoundProps,
  RedirectProps,
  ResponseTagProps,
  RouteProps,
  RouterProps,
  StructuralTag,
  UseProps,
} from "./types.js";

function toChildArray(children: unknown): DescriptorChild[] {
  if (children === undefined) return [];
  return ([] as DescriptorChild[]).concat(children as DescriptorChild);
}

function structural(tag: StructuralTag, props: Record<string, unknown>): Descriptor {
  const { children, ...rest } = props;
  return { tag, props: rest, children: toChildArray(children) };
}

export function Router(props: RouterProps = {}): Descriptor {
  return structural("router", props);
}

export function Group(props: GroupProps): Descriptor {
  return structural("group", props as Record<string, unknown>);
}

export function Route(props: RouteProps): Descriptor {
  return structural("route", props as Record<string, unknown>);
}

export function Use(props: UseProps): Descriptor {
  return structural("use", props as Record<string, unknown>);
}

export function ErrorBoundary(props: ErrorBoundaryProps): Descriptor {
  return structural("errorboundary", props as Record<string, unknown>);
}

export function NotFound(props: NotFoundProps): Descriptor {
  return structural("notfound", props as Record<string, unknown>);
}

export function Redirect(props: RedirectProps): Descriptor {
  return structural("redirect", props as Record<string, unknown>);
}

export function Response(props: ResponseTagProps): Descriptor {
  return structural("response", props as Record<string, unknown>);
}
