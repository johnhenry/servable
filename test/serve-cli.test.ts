// `servable serve` (issue #13): spawns the real bin and reads its NDJSON
// event stream, the way a desktop supervisor would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { externalOrigin, parseServeArgs, CliError, SCHEMA_VERSION, withOrigin } from "../src/serve-cli.js";

const distRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(distRoot, "src", "cli.js");
const servableIndex = pathToFileURL(join(distRoot, "src", "index.js")).href;
const isWindows = process.platform === "win32";

const fixturesRoot = join(distRoot, ".cli-fixtures");
mkdirSync(fixturesRoot, { recursive: true });

function fixtureDir(): string {
  return mkdtempSync(join(fixturesRoot, "case-"));
}

/** A module default-exporting a compiled app with the given routes (plain function calls, no JSX). */
function appSource(routes: string, prelude = ""): string {
  return `import { Router, Route, compile } from ${JSON.stringify(servableIndex)};
${prelude}
export default await compile(Router({ children: [${routes}] }));
`;
}

interface Event {
  v: number;
  event: string;
  time: string;
  [key: string]: unknown;
}

interface Running {
  child: ChildProcess;
  events: Event[];
  stdoutLines: string[];
  stderr: () => string;
  waitFor(pred: (e: Event) => boolean, timeoutMs?: number): Promise<Event>;
  exit: Promise<number | null>;
}

function run(args: string[], nodeArgs: string[] = []): Running {
  return wrap(spawn(process.execPath, [...nodeArgs, cli, ...args], { stdio: ["ignore", "pipe", "pipe"] }));
}

function wrap(child: ChildProcess): Running {
  const events: Event[] = [];
  const stdoutLines: string[] = [];
  let stderr = "";
  let buffer = "";
  const waiters: { pred: (e: Event) => boolean; resolve: (e: Event) => void; from: number }[] = [];
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      stdoutLines.push(line);
      let parsed: Event;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(parsed);
      for (const w of [...waiters]) {
        if (w.pred(parsed)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(parsed);
        }
      }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    events,
    stdoutLines,
    stderr: () => stderr,
    exit,
    waitFor(pred, timeoutMs = 10_000) {
      const seen = events.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for event; got ${JSON.stringify(events)}; stderr: ${stderr}`)),
          timeoutMs,
        );
        waiters.push({ pred, from: events.length, resolve: (e) => (clearTimeout(timer), resolve(e)) });
        exit.then(() => setTimeout(() => {
          clearTimeout(timer);
          reject(new Error(`process exited before the event; got ${JSON.stringify(events)}; stderr: ${stderr}`));
        }, 50));
      });
    },
  };
}

/** Stops a server: SIGTERM where signals exist; on Windows there's no catchable SIGTERM, so it's a hard kill. */
async function stop(r: Running): Promise<number | null> {
  r.child.kill("SIGTERM");
  return r.exit;
}

const ready = (e: Event) => e.event === "ready";

test("--port 0 --json: ready gives the real address, requests are events, SIGTERM drains and exits 0", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/hello", method: "GET", children: ["hi"] })`, `console.log("app loaded");`));
  const r = run(["serve", mod, "--port", "0", "--json"]);
  try {
    const ev = await r.waitFor(ready);
    assert.equal(ev.v, SCHEMA_VERSION);
    assert.equal(typeof ev.time, "string");
    assert.ok((ev.port as number) > 0, "OS-assigned port, not 0");
    assert.equal(ev.url, `http://127.0.0.1:${ev.port}/`);
    assert.equal(ev.ok, true);
    assert.equal(ev.reload, 0);
    assert.equal(ev.pid, r.child.pid);
    const res = await fetch(`${ev.url}hello?x=1`);
    assert.equal(await res.text(), "hi");
    const req = await r.waitFor((e) => e.event === "request");
    assert.deepEqual([req.method, req.path, req.status], ["GET", "/hello?x=1", 200]);
    assert.equal(typeof req.ms, "number");
    const code = await stop(r);
    if (!isWindows) {
      assert.equal(code, 0);
      assert.ok(r.events.some((e) => e.event === "stopping" && e.signal === "SIGTERM"));
      const stopped = r.events.at(-1)!;
      assert.equal(stopped.event, "stopped");
      assert.equal(stopped.exitCode, 0);
      assert.equal(stopped.drained, true);
    }
    // stdout is events only: the app's console.log went to stderr.
    for (const line of r.stdoutLines) assert.doesNotThrow(() => JSON.parse(line), line);
    assert.match(r.stderr(), /app loaded/);
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGINT also shuts down cleanly", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", children: ["ok"] })`));
  const r = run(["serve", mod, "--port", "0", "--json"]);
  try {
    await r.waitFor(ready);
    r.child.kill("SIGINT");
    const code = await r.exit;
    if (!isWindows) {
      assert.equal(code, 0);
      assert.ok(r.events.some((e) => e.event === "stopping" && e.signal === "SIGINT"));
    } else {
      assert.notEqual(code, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drain timeout: an open streaming response doesn't hold shutdown forever", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(
    mod,
    appSource(`Route({ path: "/stream", method: "GET", handler: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); } })) })`),
  );
  const r = run(["serve", mod, "--port", "0", "--json", "--drain-timeout", "300"]);
  try {
    const ev = await r.waitFor(ready);
    const res = await fetch(`${ev.url}stream`);
    const reader = res.body!.getReader();
    await reader.read();
    const code = await stop(r);
    reader.cancel().catch(() => {});
    if (!isWindows) {
      assert.equal(code, 0);
      assert.ok(r.events.some((e) => e.event === "warning" && e.code === "E_DRAIN_TIMEOUT"));
      assert.equal(r.events.at(-1)!.drained, false);
    }
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage errors exit 2 with E_USAGE", async () => {
  const r = run(["serve", "x.mjs", "--port", "abc", "--json"]);
  assert.equal(await r.exit, 2);
  const err = r.events.find((e) => e.event === "error")!;
  assert.equal(err.code, "E_USAGE");
  assert.equal(err.fatal, true);

  const unknown = run(["frobnicate", "--json"]);
  assert.equal(await unknown.exit, 2);
  assert.equal(unknown.events[0].code, "E_USAGE");
});

test("a missing module exits 3 with E_MODULE_NOT_FOUND; a non-app default export exits 3 with E_NOT_AN_APP", async () => {
  const dir = fixtureDir();
  try {
    const missing = run(["serve", join(dir, "nope.mjs"), "--json", "--port", "0"]);
    assert.equal(await missing.exit, 3);
    assert.equal(missing.events.find((e) => e.event === "error")!.code, "E_MODULE_NOT_FOUND");

    const notApp = join(dir, "not-app.mjs");
    writeFileSync(notApp, `export default { hello: "world" };\n`);
    const r = run(["serve", notApp, "--json", "--port", "0"]);
    assert.equal(await r.exit, 3);
    const err = r.events.find((e) => e.event === "error")!;
    assert.equal(err.code, "E_NOT_AN_APP");
    assert.match(String(err.message), /export default await compile/);

    const throws = join(dir, "throws.mjs");
    writeFileSync(throws, `throw new Error("boom at load");\n`);
    const t = run(["serve", throws, "--json", "--port", "0"]);
    assert.equal(await t.exit, 3);
    const terr = t.events.find((e) => e.event === "error")!;
    assert.equal(terr.code, "E_MODULE_LOAD");
    assert.match(String(terr.message), /boom at load/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a port already in use exits 4 with E_LISTEN", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as { port: number }).port;
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", children: ["ok"] })`));
  try {
    const r = run(["serve", mod, "--json", "--port", String(port)]);
    assert.equal(await r.exit, 4);
    const err = r.events.find((e) => e.event === "error")!;
    assert.equal(err.code, "E_LISTEN");
    assert.equal(err.errno, "EADDRINUSE");
    assert.ok(!r.events.some(ready));
  } finally {
    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handler that throws is a 500 plus a non-fatal E_REQUEST event; the server keeps running", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/boom", method: "GET", handler: () => { throw new Error("kaboom"); } }), Route({ path: "/ok", method: "GET", children: ["fine"] })`));
  const r = run(["serve", mod, "--port", "0", "--json"]);
  try {
    const ev = await r.waitFor(ready);
    assert.equal((await fetch(`${ev.url}boom`)).status, 500);
    const err = await r.waitFor((e) => e.event === "error");
    assert.equal(err.code, "E_REQUEST");
    assert.equal(err.fatal, false);
    assert.match(String(err.message), /kaboom/);
    assert.equal(await (await fetch(`${ev.url}ok`)).text(), "fine");
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--public-url sets request.url's origin; --trust-proxy honors X-Forwarded-* and Forwarded", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/whoami", method: "GET", handler: (req) => new Response(new URL(req.url).origin + " " + req.headers.get("host")) })`));
  const pub = run(["serve", mod, "--port", "0", "--json", "--public-url", "https://app.localhost"]);
  const proxied = run(["serve", mod, "--port", "0", "--json", "--trust-proxy"]);
  const plain = run(["serve", mod, "--port", "0", "--json"]);
  try {
    const a = await pub.waitFor(ready);
    assert.equal(a.publicUrl, "https://app.localhost");
    assert.equal(await (await fetch(`${a.url}whoami`, { headers: { "x-forwarded-host": "evil.test" } })).text(), "https://app.localhost app.localhost");

    const b = await proxied.waitFor(ready);
    assert.equal(
      await (await fetch(`${b.url}whoami`, { headers: { "x-forwarded-host": "api.localhost", "x-forwarded-proto": "https" } })).text(),
      "https://api.localhost api.localhost",
    );
    assert.equal(
      await (await fetch(`${b.url}whoami`, { headers: { forwarded: 'for=1.2.3.4;host="x.localhost:8443";proto=https' } })).text(),
      "https://x.localhost:8443 x.localhost:8443",
    );

    const c = await plain.waitFor(ready);
    // Without --trust-proxy the forwarded headers are ignored...
    assert.equal(await (await fetch(`${c.url}whoami`, { headers: { "x-forwarded-host": "evil.test" } })).text(), `http://127.0.0.1:${c.port} 127.0.0.1:${c.port}`);
    // ...but a proxy that preserves Host (a *.localhost name router) already works.
    const viaHost = await new Promise<string>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: c.port as number, path: "/whoami", headers: { host: "named.localhost" } }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.end();
      });
    });
    assert.equal(viaHost, "http://named.localhost named.localhost");
  } finally {
    for (const r of [pub, proxied, plain]) r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--watch: reloading/ready events, a 500 with the error while broken, recovery on the next good save, same port throughout", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  const dep = join(dir, "message.mjs");
  writeFileSync(dep, `export const message = "v1";\n`);
  writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", handler: () => new Response(message) })`, `import { message } from "./message.mjs";`));
  const r = run(["serve", mod, "--port", "0", "--json", "--watch"]);
  try {
    const first = await r.waitFor(ready);
    assert.equal(await (await fetch(first.url as string)).text(), "v1");

    // A change to a dependency (not just the entry) is picked up.
    writeFileSync(dep, `export const message = "v2";\n`);
    await r.waitFor((e) => e.event === "reloading");
    const second = await r.waitFor((e) => e.event === "ready" && (e.reload as number) > 0);
    assert.equal(second.ok, true);
    assert.equal(second.port, first.port);
    assert.equal(await (await fetch(first.url as string)).text(), "v2");

    // Broken: the server keeps listening and serves the error.
    writeFileSync(dep, `export const message = ;\n`);
    const broken = await r.waitFor((e) => e.event === "ready" && e.ok === false);
    assert.equal(broken.port, first.port);
    const err = r.events.find((e) => e.event === "error")!;
    assert.equal(err.code, "E_MODULE_LOAD");
    assert.equal(err.fatal, false);
    const res = await fetch(first.url as string);
    assert.equal(res.status, 500);
    assert.match(await res.text(), /E_MODULE_LOAD/);

    // Fixed: back to normal.
    writeFileSync(dep, `export const message = "v3";\n`);
    await r.waitFor((e) => e.event === "ready" && e.ok === true && (e.reload as number) > (broken.reload as number));
    assert.equal(await (await fetch(first.url as string)).text(), "v3");
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--watch starts even when the module is broken at launch", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, `throw new Error("not yet");\n`);
  const r = run(["serve", mod, "--port", "0", "--json", "--watch"]);
  try {
    const ev = await r.waitFor(ready);
    assert.equal(ev.ok, false);
    assert.equal((await fetch(ev.url as string)).status, 500);
    writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", children: ["now"] })`));
    await r.waitFor((e) => e.event === "ready" && e.ok === true);
    assert.equal(await (await fetch(ev.url as string)).text(), "now");
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Node permission model: runs with fs read limited to the project plus --allow-net; without --allow-net it's E_ACCESS_DENIED (exit 5)", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", children: ["sandboxed"] })`));
  // The project here is this package (the fixture imports its dist/ and
  // node_modules/); no write access, no child processes.
  const project = fileURLToPath(new URL("../../", import.meta.url));
  try {
    const ok = run(["serve", mod, "--port", "0", "--json", "--watch"], ["--permission", `--allow-fs-read=${project}`, "--allow-net"]);
    const ev = await ok.waitFor(ready);
    assert.equal(ev.ok, true);
    assert.equal(await (await fetch(ev.url as string)).text(), "sandboxed");
    ok.child.kill("SIGKILL");

    const noNet = run(["serve", mod, "--port", "0", "--json"], ["--permission", `--allow-fs-read=${project}`]);
    assert.equal(await noNet.exit, 5);
    const err = noNet.events.find((e) => e.event === "error")!;
    assert.equal(err.code, "E_ACCESS_DENIED");
    assert.match(String(err.message), /--allow-net/);

    // A module outside the readable directories.
    const outside = mkdtempSync(join(tmpdir(), "servable-cli-outside-"));
    try {
      const deniedMod = join(outside, "app.mjs");
      writeFileSync(deniedMod, appSource(`Route({ path: "/", method: "GET", children: ["x"] })`));
      const denied = run(["serve", deniedMod, "--port", "0", "--json"], ["--permission", `--allow-fs-read=${project}`, "--allow-net"]);
      assert.equal(await denied.exit, 5);
      assert.equal(denied.events.find((e) => e.event === "error")!.code, "E_ACCESS_DENIED");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseServeArgs: defaults, validation", () => {
  const opts = parseServeArgs(["app.js"], {});
  assert.ok(opts !== "help");
  assert.equal(opts.port, 3000);
  assert.equal(opts.host, "127.0.0.1");
  assert.equal(opts.json, false);
  assert.equal(opts.watch, false);
  const fromEnv = parseServeArgs(["app.js"], { PORT: "4100" });
  assert.ok(fromEnv !== "help" && fromEnv.port === 4100);
  assert.equal(parseServeArgs(["--help"], {}), "help");
  for (const bad of [[], ["a", "b"], ["a", "--port", "-1"], ["a", "--port", "70000"], ["a", "--public-url", "ftp://x"], ["a", "--public-url", "http://x/sub"], ["a", "--watch-path", "src"], ["a", "--nope"]]) {
    assert.throws(() => parseServeArgs(bad, {}), (e: unknown) => e instanceof CliError && e.code === "E_USAGE", JSON.stringify(bad));
  }
});

test("externalOrigin/withOrigin keep the body, method and leserve's raw request", async () => {
  const req = new Request("http://127.0.0.1:1234/p?q=1", { method: "POST", body: "payload", headers: { "x-forwarded-host": "a.localhost" } });
  Object.defineProperty(req, "raw", { value: "RAW" });
  assert.equal(externalOrigin(req, { trustProxy: false }), undefined);
  const origin = externalOrigin(req, { trustProxy: true })!;
  assert.equal(origin, "http://a.localhost");
  const out = withOrigin(req, origin);
  assert.equal(out.url, "http://a.localhost/p?q=1");
  assert.equal(out.method, "POST");
  assert.equal(await out.text(), "payload");
  assert.equal((out as Request & { raw?: unknown }).raw, "RAW");
  assert.equal(externalOrigin(new Request("http://h/", { headers: { "x-forwarded-port": "8080" } }), { trustProxy: true }), "http://h:8080");
});

// #15: an embedder of runServe() (hostable, or a script like this one) --
// the process doesn't exit when runServe() resolves, so these show what the
// server itself does, not what process exit hides.
const serveCliUrl = pathToFileURL(join(distRoot, "src", "serve-cli.js")).href;
const embedderSource = `import { request } from "node:http";
import { runServe, createReporter, parseServeArgs } from ${JSON.stringify(serveCliUrl)};
let uncaught = 0;
process.on("uncaughtExceptionMonitor", () => uncaught++);
const [mode, port] = process.argv.slice(2);
const options = parseServeArgs(["unused.mjs", "--port", port, "--json", "--drain-timeout", "200"]);
const base = createReporter(true);
let onReady;
const readyEvent = new Promise((resolve) => (onReady = resolve));
const reporter = { event(name, fields) { base.event(name, fields); if (name === "ready") onReady(fields); }, final: base.final };
const app = { warnings: [], fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); } })) };
const done = runServe(options, reporter, { load: async () => app });
let how;
if (mode === "drain") {
  const ev = await readyEvent;
  const closed = new Promise((resolve) => {
    const req = request(ev.url, (res) => {
      res.once("data", () => process.emit("SIGTERM", "SIGTERM"));
      res.on("error", () => resolve("closed"));
      res.on("close", () => resolve("closed"));
    });
    req.on("error", () => resolve("closed"));
    req.end();
  });
  await done;
  how = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve("still-open"), 3000))]);
}
const code = await done;
console.log(JSON.stringify({ v: 1, event: "result", code, how, uncaught }));
process.exit();
`;

function runEmbedder(args: string[]): Running {
  const dir = fixtureDir();
  const script = join(dir, "embedder.mjs");
  writeFileSync(script, embedderSource);
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const r = wrap(child);
  r.exit.finally(() => rmSync(dir, { recursive: true, force: true }));
  return r;
}

test("#15: a port in use is E_LISTEN through the server's error event, not an uncaught exception", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as { port: number }).port;
  try {
    const r = runEmbedder(["listen", String(port)]);
    const result = await r.waitFor((e) => e.event === "result");
    assert.equal(result.code, 4);
    assert.equal(result.uncaught, 0, "no uncaughtException on the listen path");
    const err = r.events.find((e) => e.event === "error")!;
    assert.deepEqual([err.code, err.errno, err.fatal], ["E_LISTEN", "EADDRINUSE", true]);
    assert.equal(err.message, `cannot listen on 127.0.0.1:${port}: listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
    assert.equal(r.events.at(-2)!.event, "stopped");
    assert.equal(r.events.at(-2)!.exitCode, 4);
  } finally {
    blocker.close();
  }
});

test("#15: after the drain timeout, connections still open are force-closed (not left to process exit)", async () => {
  const r = runEmbedder(["drain", "0"]);
  const result = await r.waitFor((e) => e.event === "result");
  assert.equal(result.code, 0);
  assert.equal(result.how, "closed");
  assert.equal(result.uncaught, 0);
  assert.ok(r.events.some((e) => e.event === "warning" && e.code === "E_DRAIN_TIMEOUT"));
  const stopped = r.events.find((e) => e.event === "stopped")!;
  assert.deepEqual([stopped.exitCode, stopped.drained], [0, false]);
});

// ---------------------------------------------------------------------------
// #21: the `routes` event and the `routes` command.

/** Runs the bin to completion: exit code, stdout, stderr. */
function runToEnd(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
}

const routesApp = appSource(
  `Route({ path: "/", method: "GET", children: ["home"] }),
   Group({ prefix: "/api", children: [Route({ path: "/users/:id", method: "GET", handler: () => new Response("u") }), NotFound({ children: ["no"] })] }),
   Redirect({ from: "/old", to: "/" })`,
).replace("import { Router, Route, compile }", "import { Router, Route, Group, NotFound, Redirect, compile }");

test("#21 serve --json: a routes event (schema v1) after the load, before ready", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, routesApp);
  const r = run(["serve", mod, "--port", "0", "--json"]);
  try {
    await r.waitFor(ready);
    const names = r.events.map((e) => e.event);
    assert.deepEqual(names.slice(0, 2), ["routes", "ready"]);
    const routes = r.events[0];
    assert.equal(routes.v, SCHEMA_VERSION);
    assert.equal(routes.complete, true);
    assert.equal(routes.notFound, true);
    assert.deepEqual(routes.backends, []);
    const hosts = routes.hosts as { hostname: string; pattern: boolean; notFoundPrefixes: string[]; routes: Record<string, unknown>[] }[];
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].hostname, "*");
    assert.deepEqual(hosts[0].notFoundPrefixes, ["/api"]);
    assert.deepEqual(hosts[0].routes, [
      { path: "/", methods: ["GET"], kind: "static", params: [], hasParams: false, prefix: "" },
      { path: "/api/users/:id", methods: ["GET"], kind: "handler", params: ["id"], hasParams: true, prefix: "/api" },
      { path: "/old", methods: ["*"], kind: "redirect", params: [], hasParams: false, prefix: "", redirect: "/", status: 301 },
    ]);
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#21 serve --json --watch: each good reload re-emits routes before its ready; a broken one doesn't", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", children: ["v1"] })`));
  const r = run(["serve", mod, "--port", "0", "--json", "--watch"]);
  const paths = (e: Event) => (e.hosts as { routes: { path: string }[] }[]).flatMap((h) => h.routes.map((x) => x.path));
  try {
    await r.waitFor(ready);
    assert.deepEqual(paths(r.events.find((e) => e.event === "routes")!), ["/"]);

    writeFileSync(mod, appSource(`Route({ path: "/", method: "GET", children: ["v2"] }), Route({ path: "/new", method: "GET", children: ["n"] })`));
    const second = await r.waitFor((e) => e.event === "ready" && (e.reload as number) > 0);
    const at = r.events.indexOf(second);
    assert.equal(r.events[at - 1].event, "routes");
    assert.deepEqual(paths(r.events[at - 1]), ["/", "/new"]);

    writeFileSync(mod, `export default ;\n`);
    const broken = await r.waitFor((e) => e.event === "ready" && e.ok === false);
    const sinceSecond = r.events.slice(at + 1, r.events.indexOf(broken));
    assert.ok(!sinceSecond.some((e) => e.event === "routes"), "no routes event for a failed load");
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#21 human serve output doesn't list routes (unchanged)", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, routesApp);
  const r = run(["serve", mod, "--port", "0"]);
  try {
    for (let i = 0; i < 200 && !/listening on/.test(r.stdoutLines.join("\n")); i++) await new Promise((res) => setTimeout(res, 25));
    assert.deepEqual(r.stdoutLines.filter((l) => l !== ""), [r.stdoutLines.find((l) => /listening on/.test(l))]);
    assert.doesNotMatch(r.stderr(), /users/);
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#21 servable routes <module>: human list, --json event, and the same load errors as serve", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, routesApp);
  try {
    const human = await runToEnd(["routes", mod]);
    assert.equal(human.code, 0);
    assert.equal(human.stdout, "(any host)\n  GET      /\n  GET      /api/users/:id\n  *        /old -> /\n");

    const json = await runToEnd(["routes", mod, "--json"]);
    assert.equal(json.code, 0);
    const lines = json.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "routes");
    assert.equal(lines[0].v, SCHEMA_VERSION);
    assert.equal(lines[0].complete, true);

    // Same report as the serve event.
    const r = run(["serve", mod, "--port", "0", "--json"]);
    try {
      const fromServe = await r.waitFor((e) => e.event === "routes");
      const strip = ({ time: _t, ...rest }: Record<string, unknown>) => rest;
      assert.deepEqual(strip(lines[0]), strip(fromServe));
    } finally {
      r.child.kill("SIGKILL");
    }

    const missing = await runToEnd(["routes", join(dir, "nope.mjs"), "--json"]);
    assert.equal(missing.code, 3);
    assert.equal(JSON.parse(missing.stdout).code, "E_MODULE_NOT_FOUND");
    const usage = await runToEnd(["routes", "--json"]);
    assert.equal(usage.code, 2);
    assert.equal(JSON.parse(usage.stdout).code, "E_USAGE");
    const help = await runToEnd(["routes", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: servable routes <module> \[--json\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#21 an app without describeRoutes(): complete false (a warning from `routes`, none from serve)", async () => {
  const dir = fixtureDir();
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, `export default { fetch: async () => new Response("hand-made"), warnings: [] };\n`);
  try {
    const out = await runToEnd(["routes", mod, "--json"]);
    assert.equal(out.code, 0);
    const [warning, routes] = out.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(warning.event, "warning");
    assert.equal(warning.code, "E_ROUTES_UNKNOWN");
    assert.deepEqual([routes.event, routes.hosts, routes.backends, routes.complete], ["routes", [], [], false]);

    const r = run(["serve", mod, "--port", "0", "--json"]);
    try {
      await r.waitFor(ready);
      assert.deepEqual(r.events.map((e) => e.event), ["routes", "ready"]);
      assert.equal(r.events[0].complete, false);
    } finally {
      r.child.kill("SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
