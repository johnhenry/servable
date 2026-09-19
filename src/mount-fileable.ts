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
 * Mapping rules:
 *  - a directory's `index.html` also serves at the directory's own path
 *    (standard static-site behavior)
 *  - a fileable `symlink` artifact becomes a `Redirect`, not a duplicate
 *    route -- a symlink *means* "this path is really that other path"
 *  - an `as="archive"` artifact (a `.zip`) is not yet mounted -- fileable's
 *    zip-assembly (`fflate` zipSync) lives in its internal write/archive.ts,
 *    which isn't part of its public API; skipped with a warning rather than
 *    reimplemented partially. Build a `<Route src>`/`serveFile()` route by
 *    hand for a zip download in the meantime.
 *  - a fileable `Rm` node has nothing to serve; skipped with a warning.
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
  target: "loose" | "archive";
  archivePath?: string;
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

  const builtRoots = fileable.build(tree);
  const resolvedRoots = await fileable.resolve(builtRoots, {});
  const laidOut = fileable.layout(resolvedRoots, {});
  for (const warning of laidOut.warnings) recordWarning(`(mounted fileable tree) ${warning}`);

  // Mounting means "serve what's inside this tree at the Group's prefix" --
  // same as Express's `express.static('dist')` under `/static` serving
  // dist's *contents* at `/static/...`, not `/static/dist/...`. The root
  // descriptor's own name is fileable's container name, not part of the
  // URL space being mounted, so it's stripped here.
  const rootName = typeof tree.props.name === "string" ? tree.props.name : undefined;
  function stripRoot(outputPath: string): string {
    if (rootName === undefined) return outputPath;
    if (outputPath === rootName) return "";
    if (outputPath.startsWith(`${rootName}/`)) return outputPath.slice(rootName.length + 1);
    return outputPath;
  }

  const routes: Descriptor[] = [];

  for (const artifact of laidOut.artifacts) {
    if (artifact.kind === "dir") continue; // no content of its own to serve
    const routePath = `/${stripRoot(artifact.outputPath)}`;

    if (artifact.target === "archive") {
      recordWarning(
        `mounted fileable tree: "${artifact.outputPath}" is inside an as="archive" subtree, which isn't ` +
          "mounted yet -- skipped. Build a <Route src>/serveFile() route by hand for a zip download.",
      );
      continue;
    }

    if (artifact.symlinkTo !== undefined) {
      const targetOutputPath = resolveSymlinkTarget(artifact.outputPath, artifact.symlinkTo);
      routes.push({
        tag: "redirect",
        props: { from: routePath, to: `/${stripRoot(targetOutputPath)}`, status: 302 },
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
      routes.push({ tag: "route", props: { path: dirPath, method: "GET", src: blob }, children: [] });
    }
  }

  return routes;
}
