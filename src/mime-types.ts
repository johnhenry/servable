/**
 * Pure extension -> Content-Type lookup. Split out of serve-file.ts (see
 * #5) so `mount-fileable.ts` -- which never touches the filesystem itself,
 * see its own module doc comment -- doesn't transitively pull in
 * serve-file.ts's Node-only `node:fs/promises` local-file-read branch just
 * to infer a Content-Type for an in-memory Blob it's already holding. Pure
 * string manipulation, no filesystem access, safe in every runtime.
 */
import { extname } from "./posix.js";

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
