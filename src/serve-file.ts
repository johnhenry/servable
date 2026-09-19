/**
 * Backs both `Route`'s `src`/`download` props and the standalone
 * `serveFile()` helper -- one mechanism for video/audio/image/pdf/download
 * serving, deliberately not five media-specific tags (see the design plan's
 * "Rejected additions"). Range support (206/`Accept-Ranges`/`Content-Range`)
 * is on by default via `Blob.prototype.slice()`, the standard platform
 * primitive for exactly this -- not a bespoke byte-slicer. Conditional
 * requests (`ETag`/`If-None-Match` -> 304) are plain `Headers` comparison,
 * not the Cache API (excluded elsewhere in this design for being
 * inconsistently supported across runtimes).
 *
 * No caching layer: every request re-reads the source. Simple, correct,
 * and consistent with excluding the Cache API -- a deliberate limitation,
 * not an oversight; compose your own caching `Use` around it if needed.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ServableError } from "./types.js";
import type { RouteContext, SrcValue } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function inferContentType(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

interface ResolvedAsset {
  blob: Blob;
  contentType: string;
  etag?: string;
  lastModified?: Date;
  filename: string;
}

async function resolveAsset(source: SrcValue): Promise<ResolvedAsset> {
  if (typeof source !== "string") {
    // An in-memory Blob (or File, which extends Blob) -- no filesystem
    // identity, so no ETag/Last-Modified; a File's own .name is used for
    // Content-Type inference and download filenames when present.
    const name = (source as { name?: string }).name ?? "download";
    return {
      blob: source,
      contentType: source.type || inferContentType(name),
      filename: name,
    };
  }
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new ServableError(`src fetch failed: ${source} (${res.status})`, source);
    }
    const blob = await res.blob();
    const filename = basename(new URL(source).pathname) || "download";
    return {
      blob,
      contentType: res.headers.get("content-type") ?? inferContentType(filename),
      etag: res.headers.get("etag") ?? undefined,
      filename,
    };
  }
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

function contentDisposition(download: boolean | string | undefined, filename: string): string | undefined {
  if (!download) return undefined;
  const name = typeof download === "string" ? download : filename;
  // eslint-disable-next-line no-control-regex
  const isAscii = /^[\x00-\x7F]*$/.test(name);
  if (isAscii) return `attachment; filename="${name.replace(/"/g, "'")}"`;
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

interface RangeSpec {
  start: number;
  end: number; // inclusive
}

/** Parses a single-range `Range: bytes=...` header. Multi-range requests are not supported (rare in practice; falls back to a full response). */
function parseRange(rangeHeader: string, totalSize: number): RangeSpec | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || match[0].includes(",")) return undefined;
  const [, startStr, endStr] = match;
  let start: number;
  let end: number;
  if (startStr === "" && endStr !== "") {
    // Suffix range: last N bytes.
    const suffixLength = Number(endStr);
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = startStr === "" ? 0 : Number(startStr);
    end = endStr === "" ? totalSize - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize || start < 0) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

export interface ServeFileOptions {
  download?: boolean | string;
}

export async function serveFile(
  req: Request,
  source: SrcValue,
  options: ServeFileOptions = {},
): Promise<globalThis.Response> {
  const asset = await resolveAsset(source);
  const totalSize = asset.blob.size;

  const headers = new Headers();
  headers.set("Content-Type", asset.contentType);
  headers.set("Accept-Ranges", "bytes");
  if (asset.etag) headers.set("ETag", asset.etag);
  if (asset.lastModified) headers.set("Last-Modified", asset.lastModified.toUTCString());
  const disposition = contentDisposition(options.download, asset.filename);
  if (disposition) headers.set("Content-Disposition", disposition);

  const ifNoneMatch = req.headers.get("if-none-match");
  if (asset.etag && ifNoneMatch && ifNoneMatch === asset.etag) {
    return new globalThis.Response(null, { status: 304, headers });
  }

  const isHead = req.method === "HEAD";
  const rangeHeader = req.headers.get("range");

  if (rangeHeader) {
    const range = parseRange(rangeHeader, totalSize);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${totalSize}`);
      return new globalThis.Response(null, { status: 416, headers });
    }
    if (range) {
      const sliced = asset.blob.slice(range.start, range.end + 1);
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new globalThis.Response(isHead ? null : sliced, { status: 206, headers });
    }
  }

  headers.set("Content-Length", String(totalSize));
  return new globalThis.Response(isHead ? null : asset.blob, { status: 200, headers });
}

/** Resolves `Route`'s `src` prop (a value, or a function of the request) into a servable asset response. */
export async function serveSrcProp(
  req: Request,
  ctx: RouteContext,
  src: SrcValue | ((req: Request, ctx: RouteContext) => SrcValue | Promise<SrcValue>),
  options: ServeFileOptions,
): Promise<globalThis.Response> {
  const resolved = typeof src === "function" ? await src(req, ctx) : src;
  return serveFile(req, resolved, options);
}
