/**
 * A tiny, dependency-free reimplementation of the handful of
 * `node:path/posix` functions servable's core actually needs: `join`,
 * `normalize`, `dirname`, `basename`, `extname`. Pure string manipulation --
 * no filesystem access, no platform detection -- so it behaves identically
 * in Node, browsers, Deno, Bun, and Cloudflare Workers.
 *
 * servable's core (compile()'s Group-prefix/Route-path joining in
 * layout.ts, the mounted-fileable-tree path joining in mount-fileable.ts,
 * and filename parsing for Content-Type inference in serve-file-core.ts)
 * only ever deals with posix-style ("/") paths -- route paths and mounted
 * URL paths, never real OS filesystem paths -- so this is deliberately
 * posix-only, not a general node:path polyfill. The genuinely Node-only
 * pieces (resolve.ts's glob expansion + dynamic `import()` of handler
 * files, serve-file.ts's local filesystem reads) still use the real
 * `node:path`/`node:path/posix`, since they're actually talking to a real
 * filesystem there and only ever run in the Node-only build (see #5's
 * writeup in CHANGELOG.md for the full split).
 *
 * The algorithms below are ported from Node.js's own `lib/path.js` posix
 * implementation (MIT-licensed, part of Node.js -- https://nodejs.org/api/path.html#pathposix)
 * so behavior matches `node:path/posix` exactly; verified directly against
 * it in test/posix.test.ts.
 */

function assertPath(path: string): void {
  if (typeof path !== "string") {
    throw new TypeError(`Path must be a string. Received ${JSON.stringify(path)}`);
  }
}

function normalizeStringPosix(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (code === 47 /* '/' */) {
      break;
    } else {
      code = 47;
    }
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
        // noop -- "//" or "/./"
      } else if (lastSlash !== i - 1 && dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== 46 ||
          res.charCodeAt(res.length - 2) !== 46
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex !== res.length - 1) {
              if (lastSlashIndex === -1) {
                res = "";
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
              }
              lastSlash = i;
              dots = 0;
              continue;
            }
          } else if (res.length === 2 || res.length === 1) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += `/${path.slice(lastSlash + 1, i)}`;
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === 46 /* '.' */ && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

/** Equivalent to `node:path/posix`'s `normalize()` -- collapses `.`/`..` segments and redundant slashes. */
export function normalize(path: string): string {
  assertPath(path);
  if (path.length === 0) return ".";
  const isAbsolutePath = path.charCodeAt(0) === 47;
  const trailingSeparator = path.charCodeAt(path.length - 1) === 47;
  let out = normalizeStringPosix(path, !isAbsolutePath);
  if (out.length === 0 && !isAbsolutePath) out = ".";
  if (out.length > 0 && trailingSeparator) out += "/";
  return isAbsolutePath ? `/${out}` : out;
}

/**
 * Equivalent to `node:path/posix`'s `join()` -- note this faithfully
 * preserves Node's own quirk of returning `"."` when every segment is
 * empty (e.g. `join("", "")`), same as the real thing. Callers that treat
 * `""` as a meaningful "no prefix yet" value (like layout.ts's basePath
 * accumulation) need their own `"." -> ""` coercion around this -- see
 * layout.ts's `joinPath()` wrapper, which is where issue #4's actual fix
 * lives.
 */
export function join(...paths: string[]): string {
  if (paths.length === 0) return ".";
  let joined = "";
  for (const path of paths) {
    assertPath(path);
    if (path.length > 0) {
      joined = joined.length === 0 ? path : `${joined}/${path}`;
    }
  }
  return joined.length === 0 ? "." : normalize(joined);
}

/** Equivalent to `node:path/posix`'s `dirname()`. */
export function dirname(path: string): string {
  assertPath(path);
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

/** Equivalent to `node:path/posix`'s `basename()`. */
export function basename(path: string, suffix?: string): string {
  assertPath(path);
  if (suffix !== undefined) assertPath(suffix);
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  let i: number;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return "";
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i;
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}

/** Equivalent to `node:path/posix`'s `extname()`. */
export function extname(path: string): string {
  assertPath(path);
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === 47 /* '/' */) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === 46 /* '.' */) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return "";
  }
  return path.slice(startDot, end);
}
