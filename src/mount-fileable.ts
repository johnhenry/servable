/**
 * `<Group from={fileableTree}>` -- mounts a fileable Descriptor tree's
 * artifacts as static routes. `@johnhenry/fileable` is a peer dependency,
 * lazily imported only here, so routing-only consumers never pay for it.
 *
 * Runs fileable's own exported `build`/`resolve`/`layout` stages (stopping
 * short of Hash/Write -- nothing is written to disk) to get a real artifact
 * list: paths, byte-exact content, binary-safety already solved by
 * fileable's own UTF-8-round-trip detection.
 *
 * NAMING -- a developer-supplied name is ALWAYS part of the mounted URL,
 * root or nested, no special-casing:
 * `<Group prefix="/static" from={<Dir name="dist"><File name="index.html">
 * .../></Dir>} />` serves at `/static/dist/index.html`, not
 * `/static/index.html`. This was deliberately reconsidered from an earlier
 * version that stripped the mount root's own name (mimicking Express's
 * `static('dist')` serving `dist`'s *contents* at the mount point) -- that
 * analogy didn't actually fit: Express's argument is a raw filesystem path,
 * never rendered anywhere, but a fileable `Dir`/`File`'s `name` is a real,
 * deliberately-authored part of the tree. If a `Dir`/`File` has a name, the
 * only reason to give it one is for it to mean something -- and the one
 * place it can mean something here is the URL. If you don't want a name in
 * the URL, don't wrap the mount in a named `Dir` at all -- use a Fragment
 * (`<>...</>`) as the mount root instead: a Fragment has no `name` of its
 * own, and its children flatten to independent top-level artifacts, each
 * still keeping ITS OWN name:
 * `<Group prefix="/static" from={<>
 *   <File name="index.html">...</File>
 *   <File name="about.html">...</File>
 * </>} />` serves at `/static/index.html` and `/static/about.html` --
 * no enclosing folder name anywhere, without needing to omit names from
 * the actual files.
 *
 * The one remaining exception is a mount root that's a bare `<File>` with
 * NO name at all (see `MOUNT_ROOT_SYNTHETIC_FILE_NAME` below) -- there is
 * no developer-supplied name there to preserve in the first place, so it
 * maps directly to the Group's own prefix, same as before.
 *
 * Other mapping rules:
 *  - a directory's `index.html` also serves at the directory's own path
 *    (standard static-site behavior) -- UNLESS the mounted root itself IS
 *    that index.html (a bare, nameless `<File>` mounted directly, whose
 *    path already collapses to the Group's prefix, see above): in that
 *    case the "also serve at directory path" route would be byte-identical
 *    to the root route already pushed, which used to crash with
 *    `duplicate route: GET /` -- fixed, see the guard around this rule's
 *    implementation.
 *  - a fileable `symlink` artifact becomes a `Redirect`, not a duplicate
 *    route -- a symlink *means* "this path is really that other path"
 *  - an `encode="zip"`/`encode="wbn"` artifact (a `.zip` or a `.wbn`) is not
 *    yet mounted -- fileable's own archive assembly (`fflate` zipSync for
 *    `"zip"`, `wbn.BundleBuilder` for `"wbn"`) lives in its internal
 *    write/zip.ts and write/wbn.ts, neither part of its public API; skipped
 *    with a warning rather than reimplemented partially. Build a
 *    `<Route src>`/`serveFile()` route by hand for a zip/wbn download in
 *    the meantime.
 *  - a fileable `Rm` node has nothing to serve; skipped with a warning.
 *
 * A fileable descriptor is only ever detected as a child of
 * `<Router>`/`<Group>` (see resolve.ts) -- one is NOT recognized under
 * `<Route>` (a `Route`'s children are a static response-value slot, a
 * different concern than "nested mountable primitives"; use `Route`'s own
 * body/`src=` handling for a single file's content at one route instead).
 */
import { dirname as posixDirname, join as posixJoin, normalize as posixNormalize, basename } from "node:path/posix";
import { recordWarning } from "./context.js";
import { inferContentType } from "./serve-file.js";
import { ServableError } from "./types.js";
import type { Descriptor, FileableTreeLike } from "./types.js";

// isFileableDescriptor() moved to types.ts, so cloneDescriptorTree (which
// runs before Build ever sees the tree) can use it too without a circular
// import -- see the comment there for the full reasoning on why it's a
// Symbol.for() registry key rather than an import of @johnhenry/fileable.

interface FileableArtifact {
  kind: "file" | "dir";
  outputPath: string;
  target: "loose" | "zip" | "wbn";
  containerPath?: string;
  content?: string | Buffer;
  symlinkTo?: string;
}

interface FileableModule {
  build: (root: unknown) => Descriptor[];
  resolve: (roots: Descriptor[], options?: Record<string, unknown>) => Promise<Descriptor[]>;
  layout: (
    roots: Descriptor[],
    options?: Record<string, unknown>,
  ) => { artifacts: FileableArtifact[]; warnings: string[] };
}

function resolveSymlinkTarget(ownOutputPath: string, symlinkTo: string): string {
  // fileable stores symlinkTo relative to the symlink's own directory (same
  // semantics as `ln -s TARGET LINK`) -- reverse that back to a path from
  // the mount root to find the real target's route.
  return posixNormalize(posixJoin(posixDirname(ownOutputPath), symlinkTo));
}

/**
 * Synthetic name given to a nameless root `<File>` mounted directly as a
 * `<Group>`/`<Router>` child (e.g. `<Group prefix="/static"><File>{"hi"}</File></Group>`).
 * fileable's own `layout()` requires a `name` on any root-level File (see
 * fileable/src/layout.ts) -- there is no way to skip that check without
 * reimplementing fileable's own content-resolution (string-joining,
 * binary/UTF-8 detection, `src=`/`cmd=` props, ...) here, which would just
 * recreate the exact kind of redundant boundary this module exists to
 * avoid. Using this name instead satisfies fileable's requirement while
 * staying invisible to callers: unlike a real, developer-supplied name
 * (which is always kept, see the module doc comment's "NAMING" section),
 * THIS name is stripped -- it's purely internal, standing in for a name
 * the developer deliberately chose not to give, not one that means
 * anything. Giving it an ".html" extension gets a sensible default
 * Content-Type from `inferContentType()` for the common case (nameless
 * File content is almost always markup/text) without guessing based on
 * content sniffing. A caller who needs a different Content-Type should
 * give the File a real `name=` with the right extension instead -- at
 * which point this synthetic name never applies, and that real name is
 * kept, not stripped.
 */
const MOUNT_ROOT_SYNTHETIC_FILE_NAME = "index.html";

export async function mountFileableTree(tree: FileableTreeLike, path: string): Promise<Descriptor[]> {
  let fileable: FileableModule;
  try {
    fileable = (await import("@johnhenry/fileable")) as unknown as FileableModule;
  } catch (cause) {
    throw new ServableError(
      '<Group from> was given a fileable tree, but "@johnhenry/fileable" isn\'t installed -- ' +
        "it's an optional peer dependency; install it to mount a fileable tree as static routes",
      path,
      cause,
    );
  }

  // A nameless root <File> (as opposed to <Dir>) -- see
  // MOUNT_ROOT_SYNTHETIC_FILE_NAME's own doc comment above for why this
  // needs a synthetic name before ever reaching fileable's own pipeline.
  const isNamelessFileRoot = tree.tag === "file" && typeof tree.props.name !== "string";
  const treeForFileable: FileableTreeLike = isNamelessFileRoot
    ? { ...tree, props: { ...tree.props, name: MOUNT_ROOT_SYNTHETIC_FILE_NAME } }
    : tree;

  const builtRoots = fileable.build(treeForFileable);
  const resolvedRoots = await fileable.resolve(builtRoots, {});
  const laidOut = fileable.layout(resolvedRoots, {});
  for (const warning of laidOut.warnings) recordWarning(`(mounted fileable tree) ${warning}`);

  // Only the SYNTHETIC name (see MOUNT_ROOT_SYNTHETIC_FILE_NAME's own doc
  // comment) is ever stripped -- a real, developer-supplied name on a
  // Dir/File mount root is part of the URL, exactly like any nested
  // Dir/File's name already is (see module doc comment's "NAMING" section).
  function stripSyntheticRootName(outputPath: string): string {
    if (!isNamelessFileRoot) return outputPath;
    if (outputPath === MOUNT_ROOT_SYNTHETIC_FILE_NAME) return "";
    // A nameless root is always a bare File with no children of its own to
    // recurse into, so this is the only outputPath that can occur here.
    return outputPath;
  }

  const routes: Descriptor[] = [];

  for (const artifact of laidOut.artifacts) {
    if (artifact.kind === "dir") continue; // no content of its own to serve
    const routePath = `/${stripSyntheticRootName(artifact.outputPath)}`;

    if (artifact.target === "zip" || artifact.target === "wbn") {
      recordWarning(
        `mounted fileable tree: "${artifact.outputPath}" is inside an encode="${artifact.target}" subtree, ` +
          `which isn't mounted yet -- skipped. Build a <Route src>/serveFile() route by hand for a ` +
          `${artifact.target} download.`,
      );
      continue;
    }

    if (artifact.symlinkTo !== undefined) {
      const targetOutputPath = resolveSymlinkTarget(artifact.outputPath, artifact.symlinkTo);
      routes.push({
        tag: "redirect",
        props: { from: routePath, to: `/${stripSyntheticRootName(targetOutputPath)}`, status: 302 },
        children: [],
      });
      continue;
    }

    const content = artifact.content ?? "";
    const blobPart = typeof content === "string" ? content : new Uint8Array(content);
    const blob = new Blob([blobPart], { type: inferContentType(artifact.outputPath) });
    routes.push({ tag: "route", props: { path: routePath, method: "GET", src: blob }, children: [] });

    if (basename(artifact.outputPath) === "index.html") {
      const dirPath = posixDirname(routePath);
      // A root-mounted index.html (rootName stripping already collapsed
      // routePath to "/") has dirPath === routePath ("/" dirname is itself)
      // -- pushing again here would be a byte-identical duplicate of the
      // route just pushed above, which layout.ts's collision check
      // correctly rejects as `duplicate route: GET /`. Real bug, not a
      // developer error: an index.html that happens to BE the mount root
      // doesn't need (and can't have) a *separate* "serves its own
      // directory" route -- it already IS that route.
      if (dirPath !== routePath) {
        routes.push({ tag: "route", props: { path: dirPath, method: "GET", src: blob }, children: [] });
      }
    }
  }

  return routes;
}
