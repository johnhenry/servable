// Real bundler regression check for issue #7: proves `import
// "@johnhenry/servable"` (and, transitively, `<Group from={fileableTree}>`'s
// mount-fileable.ts) bundles cleanly for a browser target -- zero Node
// built-ins (`node:events`, `node:fs`, `node:path`, `node:crypto`, ...) and
// zero pull-in of `glob` or `@johnhenry/fileable`'s Node-only main entry --
// using a real bundler (esbuild) against the actual *packed* npm tarball,
// not a live checkout of this repo.
//
// The packed tarball matters, not just "does it build" against src/dist in
// place: this repo's own tsconfig.json maps `#resolve`/`#serve-file` (and,
// as of #7, `#fileable`) back to their plain, unconditional `.ts` source via
// `compilerOptions.paths`, purely so `tsc` can type-check them without
// `dist/` already existing. esbuild (and other bundlers with a
// tsconfig-paths-aware resolver) ALSO honors that same tsconfig.json when
// one is reachable from the entry point -- which silently defeats the
// package.json `"imports"` conditional-exports split entirely (always
// resolving to the unconditional Node source, regardless of the `"browser"`
// condition) whenever this repo's own tsconfig.json is on disk next to the
// code being bundled, e.g. a live `npm link`/`file:`-linked checkout. A
// *published* package never ships tsconfig.json (see `files` in
// package.json), so a real downstream consumer never hits this -- but it
// means "does it build against my local checkout" is not sufficient
// evidence: the same code must be verified against the actual packed
// tarball, exactly as a real npm install would see it. This script does
// that: `npm pack` -> extract into a scratch `node_modules/` (peer deps
// symlinked from this repo's own `node_modules`, not reinstalled) -> bundle
// with esbuild `platform: "browser"`, `conditions: ["browser"]`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// On Windows, npm's own CLI is `npm.cmd` (a batch shim). execFileSync
// doesn't invoke a shell to run it at all -- that auto-wrap only happens for
// exec()/execSync(), not execFile()/execFileSync() -- and even naming
// "npm.cmd" explicitly still fails (EINVAL: spawnSync can't exec a .cmd
// directly without a shell). `shell: true` is the actual fix; it's safe
// here because every arg below is either a literal or a path this script
// generated itself (a temp dir under the OS temp root), never user input --
// and Node does properly quote array-form args for cmd.exe when `shell:
// true` is set, so this isn't the raw-string-concatenation shell-injection
// footgun `shell: true` usually implies.
const npmSpawnOpts = { shell: process.platform === "win32" };

// Forbidden marker strings in the bundled output: esbuild's default
// (non-minified) --bundle output includes a "// <relative-path>" banner
// comment per included source file, so a real Node-only file pulled into
// the bundle leaves a visible trace even in cases that don't hard-fail
// bundling outright (e.g. if some polyfill happened to be resolvable).
const FORBIDDEN_MARKERS = [
  "node_modules/glob/",
  "node_modules/@johnhenry/fileable/dist/src/api.js",
  "node_modules/@johnhenry/fileable/dist/src/resolve.js",
  "node_modules/@johnhenry/fileable/dist/src/render.js",
  "node_modules/@johnhenry/fileable/dist/src/hash.js",
  "node_modules/@johnhenry/fileable/dist/src/eject.js",
  'from "node:',
  'require("node:',
];

const ENTRY_CONTENTS = `import {
  compile, Router, Group, Host, Route, Use, ErrorBoundary, NotFound, Redirect, Response,
  build, resolve, layout,
  linkTo, warn, markdownToHtml, setCookie, sse, streamBody, upgradeWebSocket, serveFile,
} from "@johnhenry/servable";
export {
  compile, Router, Group, Host, Route, Use, ErrorBoundary, NotFound, Redirect, Response,
  build, resolve, layout,
  linkTo, warn, markdownToHtml, setCookie, sse, streamBody, upgradeWebSocket, serveFile,
};
`;

function log(msg) {
  console.log(`[check-browser-bundle] ${msg}`);
}

function main() {
  log("building (tsc)...");
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit", ...npmSpawnOpts });

  const scratchRoot = mkdtempSync(join(tmpdir(), "servable-bundle-check-"));
  const packDir = join(scratchRoot, "pack");
  const scratchDir = join(scratchRoot, "app");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });

  let result;
  let buildFailed = false;
  let buildErrors = [];

  try {
    log("npm pack...");
    const packOutput = execFileSync("npm", ["pack", "--pack-destination", packDir], {
      cwd: repoRoot,
      encoding: "utf8",
      ...npmSpawnOpts,
    }).trim();
    const tarballName = packOutput.split("\n").pop().trim();
    const tarballPath = join(packDir, tarballName);
    log(`packed ${tarballName}`);

    // Extract the tarball (npm pack always wraps contents in a "package/"
    // top-level directory) into a scratch node_modules, exactly where a
    // real `npm install @johnhenry/servable` would place it.
    const scopeDir = join(scratchDir, "node_modules", "@johnhenry");
    mkdirSync(scopeDir, { recursive: true });
    execFileSync("tar", ["-xf", tarballPath, "-C", packDir]);
    cpSync(join(packDir, "package"), join(scopeDir, "servable"), { recursive: true });

    // Peer deps -- symlinked from this repo's own already-resolved
    // node_modules (real install, no network) rather than reinstalled, so
    // this test doesn't just say "it builds," it says "it builds with a
    // real, published-shape @johnhenry/fileable providing the actual
    // ./browser subpath (#7's fix depends on this existing).
    for (const dep of ["fileable", "leserve"]) {
      const target = join(repoRoot, "node_modules", "@johnhenry", dep);
      symlinkSync(target, join(scopeDir, dep), "dir");
    }
    mkdirSync(join(scratchDir, "node_modules"), { recursive: true });
    for (const dep of ["glob", "marked", "urlpattern-polyfill"]) {
      symlinkSync(join(repoRoot, "node_modules", dep), join(scratchDir, "node_modules", dep), "dir");
    }

    const entryFile = join(scratchDir, "entry.mjs");
    writeFileSync(entryFile, ENTRY_CONTENTS);

    log("bundling with esbuild (platform: browser, conditions: [browser])...");
    result = esbuild.buildSync({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      platform: "browser",
      conditions: ["browser"],
      format: "esm",
      absWorkingDir: scratchDir,
      logLevel: "silent",
    });
  } catch (err) {
    buildFailed = true;
    buildErrors = err.errors ?? [{ text: String(err) }];
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }

  if (buildFailed) {
    console.error("[check-browser-bundle] FAIL -- esbuild could not bundle @johnhenry/servable for browser:");
    for (const e of buildErrors) console.error(`  ${e.text}`);
    console.error(
      "[check-browser-bundle] This means a Node-only module (glob, @johnhenry/fileable's Node main entry, or a " +
        "node:* built-in) is being pulled into the browser bundle -- see #7.",
    );
    process.exit(1);
  }

  const outputText = result.outputFiles.map((f) => f.text).join("\n");
  const hits = FORBIDDEN_MARKERS.filter((marker) => outputText.includes(marker));
  if (hits.length > 0) {
    console.error("[check-browser-bundle] FAIL -- browser bundle built, but contains forbidden Node-only markers:");
    for (const h of hits) console.error(`  found: ${h}`);
    process.exit(1);
  }

  log(`PASS -- browser bundle built clean (${outputText.length} bytes), no Node-only markers found.`);
}

main();
