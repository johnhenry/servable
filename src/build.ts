/**
 * Stage 1: Build.
 *
 * The jsx-runtime already evaluated the JSX tree synchronously into raw
 * descriptor objects; this stage normalizes the result into a canonical
 * shape so every later stage can rely on it:
 *  - fragments are flattened into their parent's children
 *  - nested arrays (from `.map()`) are flattened
 *  - null/undefined/boolean children are dropped (the usual `{cond && <x/>}` idiom)
 *  - number children become strings
 *  - every Descriptor gets a stable `__id` (used later for linkTo() lookups)
 *
 * Mirrors fileable/src/build.ts exactly, including the fix fileable needed:
 * a Promise ending up as JSX *content* (e.g. calling an async component --
 * `<AsyncFoo/>` invokes it immediately and gets back a Promise, not its
 * eventual result) throws instead of silently stringifying to
 * "[object Promise]".
 */
import { FRAGMENT, isDescriptor, isLinkRef, isThenable, ServableError } from "./types.js";
import type { Descriptor, DescriptorChild } from "./types.js";

export function build(root: unknown): Descriptor[] {
  let counter = 0;
  const nextId = () => `n${counter++}`;

  function normalizeOne(node: Descriptor): Descriptor[] {
    node.children = normalizeChildren(node.children);
    if (node.__id === undefined) node.__id = nextId();
    if (node.tag === FRAGMENT) {
      return node.children.filter(isDescriptor);
    }
    return [node];
  }

  function normalizeChildren(children: unknown): DescriptorChild[] {
    const flat: DescriptorChild[] = [];
    const items = Array.isArray(children) ? children : [children];
    for (const item of items) {
      if (item === null || item === undefined || typeof item === "boolean") {
        continue;
      }
      if (Array.isArray(item)) {
        flat.push(...normalizeChildren(item));
        continue;
      }
      if (typeof item === "number") {
        flat.push(String(item));
        continue;
      }
      if (isDescriptor(item)) {
        flat.push(...normalizeOne(item));
        continue;
      }
      if (isLinkRef(item) || typeof item === "string") {
        flat.push(item);
        continue;
      }
      if (isThenable(item)) {
        throw new ServableError(
          "a Promise can't be used directly as JSX content (only as a prop value, e.g. `handler`/`src`, or any " +
            "other prop) -- await it yourself before rendering, or pass it as a prop instead",
          "<jsx child>",
        );
      }
      if (typeof item === "function") {
        throw new ServableError(
          "a function can't be used directly as JSX content -- routes take a handler via the `handler` prop, " +
            "not as content",
          "<jsx child>",
        );
      }
      // Anything else (a plain object, Blob, ArrayBuffer, FormData,
      // URLSearchParams, ReadableStream, a real Response, ...) is a
      // legitimate static Route/Response value in this domain -- unlike
      // fileable, where children must eventually be textual/binary file
      // content, so passed through unchanged rather than stringified.
      // compile.ts's resolveStaticChildren is what actually interprets it.
      flat.push(item as DescriptorChild);
    }
    return flat;
  }

  return normalizeChildren(root).filter(isDescriptor);
}
