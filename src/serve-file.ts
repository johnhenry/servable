/**
 * Node/full build of serve-file-core.ts's `serveFile`/`serveSrcProp` -- adds
 * the one genuinely Node-only capability, reading a plain string `src` off
 * the local filesystem (`node:fs/promises`), on top of the browser-safe
 * Blob/`http(s)://`/`ipfs://` handling shared with serve-file.browser.ts.
 * Resolved automatically via this package's `#serve-file` internal import
 * (see package.json's `imports` field) whenever a bundler/runtime doesn't
 * explicitly resolve the `"browser"` condition -- see #5.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { ServableError } from "./types.js";
import { inferContentType } from "./mime-types.js";
import { createServeFile, type ResolvedAsset } from "./serve-file-core.js";

export { inferContentType } from "./mime-types.js";
export type { ServeFileOptions } from "./serve-file-core.js";

async function readLocalFile(source: string): Promise<ResolvedAsset> {
  let buffer: Buffer;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    [buffer, stats] = await Promise.all([readFile(source), stat(source)]);
  } catch (cause) {
    throw new ServableError(`failed to read src file "${source}"`, source, cause);
  }
  const filename = basename(source);
  return {
    blob: new Blob([new Uint8Array(buffer)], { type: inferContentType(filename) }),
    contentType: inferContentType(filename),
    etag: `"${stats.size}-${stats.mtimeMs}"`,
    lastModified: stats.mtime,
    filename,
  };
}

const { serveFile, serveSrcProp } = createServeFile({ readLocalFile });

export { serveFile, serveSrcProp };
