/**
 * `servable serve <module>` -- the machine interface a desktop app (or any
 * supervisor) drives servable apps through (issue #13). Node only.
 *
 * The contract, in one place (README "Command line" documents it for
 * users; keep the two in sync):
 *
 * - The module's default export is a compiled app: the `{ fetch, warnings }`
 *   value `await compile(<Router>...</Router>)` returns. The module must not
 *   call `serve()` itself.
 * - With `--json`, stdout carries only NDJSON events, one per line, every
 *   one shaped `{ "v": 1, "event": <name>, "time": <ISO-8601>, ...fields }`.
 *   `v` is the schema version; it changes only on an incompatible change
 *   (a removed or retyped field), never for an added field or event.
 *   The app's own `console.log`/`info`/`debug` go to stderr in this mode.
 * - Stable error codes (`E_*`) and exit codes, see `ERROR_CODES` below.
 *
 * leserve is a regular dependency on this path (the Node adapter needs it);
 * this file is never imported by the package's main entry, so routing-only
 * consumers still don't load it.
 *
 * It's also exported as `@johnhenry/servable/cli` (#17), so a package built
 * on servable (hostable) runs the same contract instead of a copy: the
 * `RunHooks` below add error codes, request-error mapping, human renderings
 * for extra events, and the product strings (label, usage, reload query
 * parameter, the 500 page's text, the not-an-app hint). Every hook defaults
 * to servable's own behaviour.
 */
import { parseArgs } from "node:util";
import { registerHooks } from "node:module";
import { statSync, watch, type FSWatcher } from "node:fs";
import { dirname, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { serve as nodeServe } from "../adapters/node.js";
import type { CompileResult } from "./types.js";

/** Event schema version. Bump only for an incompatible change. */
export const SCHEMA_VERSION = 1;

/** Process exit codes. Stable: a supervisor may branch on them. */
export const EXIT = {
  /** Clean shutdown (SIGTERM/SIGINT, drained). */
  OK: 0,
  /** Unexpected internal error, or an uncaught exception from the app after it started. */
  INTERNAL: 1,
  /** Bad command line. */
  USAGE: 2,
  /** The module couldn't be found or loaded, or its default export isn't a compiled app. */
  MODULE: 3,
  /** The server couldn't listen (port in use, privileged port, bad host). */
  LISTEN: 4,
  /** Node's permission model denied something the server needs (`--allow-net`, a read outside `--allow-fs-read`). */
  ACCESS_DENIED: 5,
} as const;

/** Every error code the CLI emits, mapped to the exit code it ends the process with when fatal. */
export const ERROR_CODES = {
  E_USAGE: EXIT.USAGE,
  E_MODULE_NOT_FOUND: EXIT.MODULE,
  E_MODULE_LOAD: EXIT.MODULE,
  E_NOT_AN_APP: EXIT.MODULE,
  E_LISTEN: EXIT.LISTEN,
  E_ACCESS_DENIED: EXIT.ACCESS_DENIED,
  E_INTERNAL: EXIT.INTERNAL,
  /** Never fatal: a request handler threw and no `<ErrorBoundary>` caught it. The client gets a 500. */
  E_REQUEST: EXIT.INTERNAL,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;
/** One of `ERROR_CODES`, or a code an embedder added through `RunHooks.errorCodes`. */
export type AnyErrorCode = ErrorCode | (string & {});

/** The exit code a fatal error with `code` ends the process with: `extra` first, then `ERROR_CODES`, else `EXIT.INTERNAL`. */
export function exitCodeFor(code: unknown, extra: Readonly<Record<string, number>> = {}): number {
  if (typeof code !== "string") return EXIT.INTERNAL;
  if (Object.hasOwn(extra, code)) return extra[code];
  return Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code as ErrorCode] : EXIT.INTERNAL;
}

export class CliError extends Error {
  constructor(
    readonly code: AnyErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ServeOptions {
  module: string;
  port: number;
  host: string;
  json: boolean;
  watch: boolean;
  watchPaths: string[];
  publicUrl?: URL;
  trustProxy: boolean;
  drainTimeoutMs: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DRAIN_MS = 10_000;

/**
 * `serve`'s help text for a program: `serveUsage()` is servable's own
 * (`SERVE_USAGE`). `compileArgument` is what the help shows inside
 * `compile(...)`, e.g. `<Gateway>...</Gateway>`.
 */
export function serveUsage(program = "servable", compileArgument = "..."): string {
  return `Usage: ${program} serve <module> [options]

Serve the compiled app a module default-exports (export default await compile(${compileArgument})).

Options:
  --port <n>            Port to listen on; 0 picks a free one (default: $PORT or ${DEFAULT_PORT})
  --host <host>         Interface to bind (default: ${DEFAULT_HOST})
  --json                NDJSON events on stdout (ready, request, reloading, error, ...)
  --watch               Re-import the module when files change; serve a 500 while it's broken
  --watch-path <path>   Directory to watch (repeatable; default: the module's directory)
  --public-url <url>    Origin the app is reached at (e.g. http://app.localhost); sets request.url's origin
  --trust-proxy         Honor Forwarded / X-Forwarded-Host / -Proto / -Port for request.url
  --drain-timeout <ms>  How long shutdown waits for in-flight requests (default: ${DEFAULT_DRAIN_MS})
  -h, --help            Show this help
`;
}

export const SERVE_USAGE = serveUsage();

/** Parses `serve`'s arguments (everything after the word `serve`). Throws `CliError("E_USAGE")`. */
export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeOptions | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        json: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        "watch-path": { type: "string", multiple: true },
        "public-url": { type: "string" },
        "trust-proxy": { type: "boolean", default: false },
        "drain-timeout": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new CliError("E_USAGE", (error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length !== 1) {
    throw new CliError("E_USAGE", positionals.length === 0 ? "missing <module>" : `expected one <module>, got ${positionals.length}`);
  }
  const port = parsePort(values.port ?? env.PORT ?? String(DEFAULT_PORT));
  const host = values.host ?? DEFAULT_HOST;
  if (host === "") throw new CliError("E_USAGE", "--host must not be empty");
  let publicUrl: URL | undefined;
  if (values["public-url"] !== undefined) {
    try {
      publicUrl = new URL(values["public-url"]);
    } catch {
      throw new CliError("E_USAGE", `--public-url is not a URL: ${values["public-url"]}`);
    }
    if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
      throw new CliError("E_USAGE", "--public-url must be http: or https:");
    }
    if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
      throw new CliError("E_USAGE", "--public-url must be an origin only (no path, query or fragment)");
    }
  }
  const drainRaw = values["drain-timeout"] ?? String(DEFAULT_DRAIN_MS);
  const drainTimeoutMs = Number(drainRaw);
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 0) {
    throw new CliError("E_USAGE", `--drain-timeout must be a whole number of milliseconds, got ${drainRaw}`);
  }
  const module = resolvePath(positionals[0]);
  const watchPaths = (values["watch-path"] ?? []).map((p) => resolvePath(p));
  if (!values.watch && watchPaths.length > 0) throw new CliError("E_USAGE", "--watch-path needs --watch");
  return {
    module,
    port,
    host,
    json: values.json,
    watch: values.watch,
    watchPaths: values.watch && watchPaths.length === 0 ? [dirname(module)] : watchPaths,
    publicUrl,
    trustProxy: values["trust-proxy"],
    drainTimeoutMs,
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError("E_USAGE", `--port must be an integer from 0 to 65535, got ${raw}`);
  }
  return port;
}

// ---------------------------------------------------------------------------
// Events

export type EventFields = Record<string, unknown>;

export interface Reporter {
  event(name: string, fields?: EventFields): void;
  /** Writes the last event and calls back once it has been flushed, so exiting right after doesn't truncate it. */
  final(name: string, fields: EventFields, done: () => void): void;
}

/**
 * Human (non-`--json`) rendering of one event: the text and which stream
 * it goes to, or undefined to print nothing. `--json` output never uses it.
 */
export type HumanRenderer = (fields: EventFields, label: string) => { to: "stdout" | "stderr"; text: string } | undefined;

export interface ReporterOptions {
  /** Program name prefixed to human output (default `"servable"`). */
  label?: string;
  /** Human renderings for extra events, or overrides for built-in ones, by event name. */
  renderers?: Readonly<Record<string, HumanRenderer>>;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export function createReporter(
  json: boolean,
  labelOrOptions: string | ReporterOptions = "servable",
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Reporter {
  const options: ReporterOptions = typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
  const label = options.label ?? "servable";
  if (options.out) out = options.out;
  if (options.err) err = options.err;
  const renderers = options.renderers ?? {};
  const line = (name: string, fields: EventFields): string =>
    JSON.stringify({ v: SCHEMA_VERSION, event: name, time: new Date().toISOString(), ...fields }) + "\n";
  const human = (name: string, fields: EventFields): [NodeJS.WritableStream, string] | undefined => {
    if (Object.hasOwn(renderers, name)) {
      const rendered = renderers[name](fields, label);
      return rendered && [rendered.to === "stdout" ? out : err, rendered.text];
    }
    switch (name) {
      case "ready":
        return fields.ok === false
          ? [err, `${label}: listening on ${fields.url} (app failed to load; serving 500 until the next good save)\n`]
          : [out, `${label}: listening on ${fields.url}${fields.publicUrl ? ` (public ${fields.publicUrl})` : ""}\n`];
      case "request":
        return [out, `${fields.method} ${fields.path} ${fields.status} ${fields.ms}ms\n`];
      case "reloading":
        return [err, `${label}: change detected, reloading\n`];
      case "warning":
        return [err, `${label}: warning: ${fields.message}\n`];
      case "error":
        return [err, `${label}: error ${fields.code}: ${fields.message}\n`];
      case "stopping":
        return [err, `${label}: ${fields.signal} received, draining\n`];
      case "stopped":
        return undefined;
      default:
        return [err, `${label}: ${name} ${JSON.stringify(fields)}\n`];
    }
  };
  return {
    event(name, fields = {}) {
      if (json) out.write(line(name, fields));
      else {
        const h = human(name, fields);
        if (h) h[0].write(h[1]);
      }
    },
    final(name, fields, done) {
      if (json) out.write(line(name, fields), () => done());
      else {
        const h = human(name, fields);
        if (h) h[0].write(h[1], () => done());
        else done();
      }
    },
  };
}

export function errorFields(error: unknown, fatal: boolean): EventFields {
  if (error instanceof CliError) return { code: error.code, message: error.message, fatal, ...error.details };
  const e = error as { message?: string; stack?: string } | undefined;
  return { code: "E_INTERNAL", message: e?.message ?? String(error), fatal, stack: e?.stack };
}

// ---------------------------------------------------------------------------
// Module loading

/** True for the `{ fetch, warnings }` shape `compile()` returns (servable's or hostable's). */
export function isCompiledApp(value: unknown): value is CompileResult {
  return typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function";
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined (no default export)";
  if (value === null) return "null";
  if (typeof value === "function") return "a function";
  if (typeof value === "object" && "tag" in (value as object) && "children" in (value as object)) return "an uncompiled JSX tree";
  return typeof value === "object" ? "an object without a fetch() method" : `a ${typeof value}`;
}

/** Converts an import()/stat failure into a stable CliError. */
export function classifyLoadError(error: unknown, modulePath: string): CliError {
  const e = error as { code?: string; message?: string; stack?: string; permission?: string; resource?: string };
  if (e?.code === "ERR_ACCESS_DENIED") {
    return new CliError("E_ACCESS_DENIED", `permission denied while loading ${modulePath}: ${e.message}`, {
      permission: e.permission,
      resource: e.resource || undefined,
    });
  }
  if (e?.code === "ENOENT") return new CliError("E_MODULE_NOT_FOUND", `no such module: ${modulePath}`);
  if (e instanceof CliError) return e;
  return new CliError("E_MODULE_LOAD", `failed to load ${modulePath}: ${e?.message ?? String(error)}`, { stack: e?.stack });
}

/** The product strings `loadApp()` uses. */
export interface LoadOptions {
  /** Query parameter that tags a reload's fresh module copies (default `GENERATION_PARAM`). */
  reloadParam?: string;
  /** What `E_NOT_AN_APP` tells the user to write (default `DEFAULT_COMPILE_HINT`). */
  compileHint?: string;
}

/** servable's `E_NOT_AN_APP` hint. */
export const DEFAULT_COMPILE_HINT = "export default await compile(<Router>...</Router>)";

/**
 * Imports `modulePath` and returns its default export as a compiled app.
 * `generation > 0` imports a fresh copy (see `installReloadHooks()`).
 */
export async function loadApp(modulePath: string, generation = 0, loadOptions: LoadOptions = {}): Promise<CompileResult> {
  const reloadParam = loadOptions.reloadParam ?? GENERATION_PARAM;
  try {
    statSync(modulePath);
  } catch (error) {
    throw classifyLoadError(error, modulePath);
  }
  let mod: { default?: unknown };
  try {
    const url = pathToFileURL(modulePath);
    if (generation > 0) url.searchParams.set(reloadParam, String(generation));
    mod = await import(url.href);
  } catch (error) {
    throw classifyLoadError(error, modulePath);
  }
  const app = await mod.default;
  if (!isCompiledApp(app)) {
    throw new CliError(
      "E_NOT_AN_APP",
      `the default export of ${modulePath} is ${describeValue(app)}; expected a compiled app -- ${loadOptions.compileHint ?? DEFAULT_COMPILE_HINT}`,
    );
  }
  return app;
}

// ---------------------------------------------------------------------------
// Watch/reload: re-import in-process, with a fresh copy of every module
// under the watched directories (node_modules excluded), so the listening
// socket -- and with it the port the supervisor routes to -- never changes.

export const GENERATION_PARAM = "servable-reload";
let hooksInstalled = false;

/**
 * Tags every module resolved from a tagged parent (inside `roots`, outside
 * node_modules) with the parent's generation, so a re-import of the entry
 * module with a new generation re-evaluates the project's own files too,
 * not only the entry. Dependencies in node_modules stay shared (so e.g.
 * servable's own trailer WeakMap is the one the adapter reads).
 */
export function installReloadHooks(roots: string[], reloadParam = GENERATION_PARAM): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const rootPrefixes = roots.map((r) => (r.endsWith(sep) ? r : r + sep));
  const inScope = (url: string): boolean => {
    if (!url.startsWith("file:")) return false;
    let path: string;
    try {
      path = fileURLToPath(url);
    } catch {
      return false;
    }
    if (path.split(sep).includes("node_modules")) return false;
    if (/\.(cjs|json|node|wasm)$/.test(path)) return false;
    return rootPrefixes.some((p) => path.startsWith(p));
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const parent = context.parentURL;
      if (!parent || !parent.includes(reloadParam)) return result;
      let generation: string | null;
      try {
        generation = new URL(parent).searchParams.get(reloadParam);
      } catch {
        return result;
      }
      if (!generation || !inScope(result.url)) return result;
      const url = new URL(result.url);
      url.searchParams.set(reloadParam, generation);
      return { ...result, url: url.href };
    },
  });
}

function startWatching(paths: string[], onChange: (files: string[]) => void, onError: (error: unknown) => void): FSWatcher[] {
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  for (const root of paths) {
    const watcher = watch(root, { recursive: true }, (_type, filename) => {
      const name = filename ? String(filename) : "";
      if (name.split(/[\\/]/).some((part) => part === "node_modules" || part === ".git")) return;
      pending.add(name ? resolvePath(root, name) : root);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending = new Set();
        onChange(files);
      }, 100);
    });
    watcher.on("error", onError);
    watchers.push(watcher);
  }
  return watchers;
}

// ---------------------------------------------------------------------------
// Public URL / forwarded headers

/** First `Forwarded` (RFC 7239) element's `host`/`proto`, if present. */
function parseForwarded(value: string | null): { host?: string; proto?: string } {
  if (!value) return {};
  const first = value.split(",")[0];
  const out: { host?: string; proto?: string } = {};
  for (const pair of first.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const val = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") out.host = val;
    else if (key === "proto") out.proto = val.toLowerCase();
  }
  return out;
}

const firstValue = (value: string | null): string | undefined => value?.split(",")[0].trim() || undefined;

/**
 * The origin the client actually used: `--public-url` if set; otherwise,
 * with `--trust-proxy`, `Forwarded` then `X-Forwarded-Host`/`-Proto`/
 * `-Port`; otherwise unchanged (the `Host` header, which a proxy that
 * preserves it -- like a `*.localhost` name router -- already gets right).
 * Returns undefined when nothing changes.
 */
export function externalOrigin(request: Request, options: { publicUrl?: URL; trustProxy: boolean }): string | undefined {
  if (options.publicUrl) return options.publicUrl.origin;
  if (!options.trustProxy) return undefined;
  const headers = request.headers;
  const forwarded = parseForwarded(headers.get("forwarded"));
  const host = forwarded.host ?? firstValue(headers.get("x-forwarded-host"));
  const proto = forwarded.proto ?? firstValue(headers.get("x-forwarded-proto"))?.toLowerCase();
  const port = firstValue(headers.get("x-forwarded-port"));
  if (!host && !proto && !port) return undefined;
  const current = new URL(request.url);
  const scheme = proto === "https" || proto === "http" ? proto : current.protocol.slice(0, -1);
  try {
    const url = new URL(`${scheme}://${host ?? current.host}`);
    if (port && !forwarded.host && /^\d+$/.test(port)) url.port = port;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** A copy of `request` at `origin`, with `Host` updated to match and leserve's raw `IncomingMessage` (WebSocket upgrades need it) carried over. */
export function withOrigin(request: Request, origin: string): Request {
  const current = new URL(request.url);
  const next = new URL(current.pathname + current.search, origin);
  if (next.href === current.href) return request;
  const headers = new Headers(request.headers);
  headers.set("host", next.host);
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: request.signal };
  if (request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  const rewritten = new Request(next.href, init);
  const raw = (request as Request & { raw?: unknown }).raw;
  if (raw !== undefined) Object.defineProperty(rewritten, "raw", { value: raw, enumerable: false });
  return rewritten;
}

// ---------------------------------------------------------------------------
// The server

/** servable's 500-page headline while the module is broken. */
export const DEFAULT_LOAD_FAILED_MESSAGE = "the app failed to load";

/** A stand-in app served while the module is broken under `--watch`. Its body starts `<label>: <message>`. */
export function brokenApp(error: CliError, label = "servable", message = DEFAULT_LOAD_FAILED_MESSAGE): CompileResult {
  const body = `${label}: ${message}\n\n${error.code}: ${error.message}\n${typeof error.details.stack === "string" ? `\n${error.details.stack}\n` : ""}`;
  return {
    warnings: [],
    fetch: async () => new Response(body, { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }),
  };
}

export function formatUrl(host: string, port: number, protocol = "http:"): string {
  const shown = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `${protocol}//${shown.includes(":") ? `[${shown}]` : shown}:${port}/`;
}

export interface RunHooks {
  /** Program name in human output and the 500 page (default `"servable"`). */
  label?: string;
  /** Loads the app (default `loadApp` with `reloadParam` and `compileHint`). */
  load?: (modulePath: string, generation: number) => Promise<CompileResult>;
  /** Called after each successful load, before `ready` -- hostable emits its `routes` event here. */
  afterLoad?: (app: CompileResult, reporter: Reporter) => void | Promise<void>;
  /**
   * Turns an error the app's `fetch()` threw into a response, reporting its
   * own event (hostable: an unreachable `<Upstream url=>` is a 502/504 with
   * `E_UPSTREAM`). Return undefined for the default: a 500 and a non-fatal
   * `E_REQUEST` event.
   */
  requestError?: (error: unknown, reporter: Reporter) => Response | undefined;
  /** Extra error codes and the exit code each ends the process with when fatal (see `exitCodeFor()`). */
  errorCodes?: Readonly<Record<string, number>>;
  /** Human renderings for extra events (hostable: `routes`), see `createReporter()`. Used by `serveCommand()`. */
  renderers?: Readonly<Record<string, HumanRenderer>>;
  /** Query parameter tagging a reload's fresh module copies (default `GENERATION_PARAM`, `servable-reload`). */
  reloadParam?: string;
  /** Headline of the 500 page served while the module is broken (default `"the app failed to load"`). */
  loadFailedMessage?: string;
  /** What `E_NOT_AN_APP` tells the user to write (default `DEFAULT_COMPILE_HINT`). Used by the default `load`. */
  compileHint?: string;
}

/**
 * Runs `serve` until a signal stops it. Resolves with the exit code; the
 * caller (bin) exits with it. Fatal errors are reported as `error` events
 * before resolving.
 */
export function runServe(options: ServeOptions, reporter: Reporter, hooks: RunHooks = {}): Promise<number> {
  const label = hooks.label ?? "servable";
  const reloadParam = hooks.reloadParam ?? GENERATION_PARAM;
  const load = hooks.load ?? ((modulePath: string, generation: number) => loadApp(modulePath, generation, { reloadParam, compileHint: hooks.compileHint }));
  return new Promise<number>((settle) => {
    let app: CompileResult | undefined;
    let ok = false;
    let generation = 0;
    let listening = false;
    let stopping = false;
    let finished = false;
    let port = options.port;
    let watchers: FSWatcher[] = [];
    let handle: ReturnType<typeof nodeServe> | undefined;
    const abort = new AbortController();

    const finish = (code: number, fields: EventFields = {}) => {
      if (finished) return;
      finished = true;
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("uncaughtException", onUncaught);
      for (const w of watchers) w.close();
      reporter.final("stopped", { exitCode: code, ...fields }, () => settle(code));
    };
    const fatal = (error: CliError | unknown) => {
      const fields = errorFields(error, true);
      reporter.event("error", fields);
      abort.abort();
      finish(exitCodeFor(fields.code, hooks.errorCodes));
    };

    function onSignal(signal: NodeJS.Signals) {
      if (stopping) {
        // A second signal skips the drain.
        reporter.event("warning", { code: "E_DRAIN_SKIPPED", message: `second ${signal}: exiting without waiting for in-flight requests` });
        finish(EXIT.OK, { drained: false });
        return;
      }
      stopping = true;
      reporter.event("stopping", { signal });
      for (const w of watchers) w.close();
      watchers = [];
      if (!handle) return finish(EXIT.OK, { drained: true });
      const timer = setTimeout(() => {
        reporter.event("warning", { code: "E_DRAIN_TIMEOUT", message: `in-flight requests still open after ${options.drainTimeoutMs}ms; exiting anyway` });
        // Force-close what's still open, so stopping doesn't depend on the
        // process exiting (an embedder of runServe() may keep running).
        handle?.server?.closeAllConnections?.();
        finish(EXIT.OK, { drained: false });
      }, options.drainTimeoutMs);
      timer.unref?.();
      abort.abort();
      handle.finished.then(() => {
        clearTimeout(timer);
        finish(EXIT.OK, { drained: true });
      });
    }

    /** Classifies a server-side or uncaught error and ends the run with it. */
    function onFatal(error: unknown) {
      const e = error as { code?: string; syscall?: string; permission?: string; message?: string };
      if (e?.code === "ERR_ACCESS_DENIED") {
        fatal(new CliError("E_ACCESS_DENIED", e.message ?? "permission denied", { permission: e.permission }));
      } else if (!listening && e?.syscall === "listen") {
        fatal(new CliError("E_LISTEN", `cannot listen on ${options.host}:${options.port}: ${e.message}`, { errno: e.code }));
      } else {
        fatal(error);
      }
    }

    // Listen errors arrive through the adapter's onError (the server's own
    // 'error' event); this catches what the app itself throws uncaught.
    function onUncaught(error: unknown) {
      onFatal(error);
    }

    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    process.on("uncaughtException", onUncaught);

    const publish = (loaded: CompileResult) => {
      for (const message of loaded.warnings) reporter.event("warning", { message });
    };

    const ready = () =>
      reporter.event("ready", {
        url: formatUrl(options.host, port),
        host: options.host,
        port,
        publicUrl: options.publicUrl?.origin ?? null,
        module: options.module,
        pid: process.pid,
        ok,
        reload: generation,
      });

    const tryLoad = async (): Promise<boolean> => {
      try {
        const loaded = await load(options.module, generation);
        await hooks.afterLoad?.(loaded, reporter);
        publish(loaded);
        app = loaded;
        ok = true;
        return true;
      } catch (error) {
        const cliError = error instanceof CliError ? error : classifyLoadError(error, options.module);
        if (!options.watch) throw cliError;
        reporter.event("error", errorFields(cliError, false));
        app = brokenApp(cliError, label, hooks.loadFailedMessage);
        ok = false;
        return false;
      }
    };

    const dispatch: CompileResult = {
      warnings: [],
      fetch: async (incoming: Request) => {
        const started = performance.now();
        const origin = externalOrigin(incoming, options);
        const request = origin ? withOrigin(incoming, origin) : incoming;
        let response: Response;
        try {
          response = await app!.fetch(request);
        } catch (error) {
          const mapped = hooks.requestError?.(error, reporter);
          if (mapped) response = mapped;
          else {
            reporter.event("error", { ...errorFields(error, false), code: "E_REQUEST" });
            response = new Response("Internal Server Error", { status: 500 });
          }
        }
        const url = new URL(request.url);
        reporter.event("request", {
          method: request.method,
          host: url.host,
          path: url.pathname + url.search,
          status: response.status,
          ms: Math.round((performance.now() - started) * 10) / 10,
        });
        return response;
      },
    };

    const reload = async (files: string[]) => {
      if (stopping) return;
      generation += 1;
      reporter.event("reloading", { files: files.map((f) => relative(process.cwd(), f) || f) });
      await tryLoad();
      if (!stopping) ready();
    };

    (async () => {
      if (options.watch) installReloadHooks(options.watchPaths, reloadParam);
      await tryLoad();
      if (stopping) return;
      // Node's permission model throws ERR_ACCESS_DENIED asynchronously
      // out of listen() without --allow-net; check up front for a clear error.
      const permission = (process as { permission?: { has(scope: string): boolean } }).permission;
      if (permission && !permission.has("net")) {
        throw new CliError("E_ACCESS_DENIED", "listening needs network access: run node with --allow-net alongside --permission", { permission: "Net" });
      }
      if (options.watch) {
        watchers = startWatching(options.watchPaths, (files) => void reload(files), (error) => {
          reporter.event("warning", { code: "E_WATCH", message: `watcher error: ${(error as Error).message}` });
        });
      }
      handle = nodeServe(dispatch, {
        port: options.port,
        hostname: options.host,
        signal: abort.signal,
        onError: onFatal,
        onListen: (info) => {
          listening = true;
          port = info.port;
          if (stopping) return;
          ready();
        },
      });
    })().catch(fatal);
  });
}

/** Runs the whole `serve` command from argv; resolves with an exit code. */
export async function serveCommand(argv: string[], hooks: RunHooks & { usage?: string } = {}): Promise<number> {
  const json = argv.includes("--json");
  const reporter = createReporter(json, { label: hooks.label, renderers: hooks.renderers });
  let options: ServeOptions | "help";
  try {
    options = parseServeArgs(argv);
  } catch (error) {
    const fields = errorFields(error, true);
    if (!json) process.stderr.write(hooks.usage ?? SERVE_USAGE);
    await new Promise<void>((done) => reporter.final("error", fields, done));
    return exitCodeFor(fields.code, hooks.errorCodes);
  }
  if (options === "help") {
    process.stdout.write(hooks.usage ?? SERVE_USAGE);
    return EXIT.OK;
  }
  if (options.json) redirectConsoleToStderr();
  return runServe(options, reporter, hooks);
}

/** In --json mode stdout is reserved for events: the app's console.log/info/debug go to stderr instead. */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
