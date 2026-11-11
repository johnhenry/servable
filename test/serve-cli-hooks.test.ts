// `@johnhenry/servable/cli` (#17): the serve runtime as a library, with the
// hooks a package built on servable (hostable) needs. An embedder bin
// ("acme") sets every hook; the same scenarios without hooks pin servable's
// own defaults, so the `servable` bin's output doesn't change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CliError,
  DEFAULT_COMPILE_HINT,
  DEFAULT_LOAD_FAILED_MESSAGE,
  ERROR_CODES,
  EXIT,
  GENERATION_PARAM,
  SERVE_USAGE,
  brokenApp,
  createReporter,
  exitCodeFor,
  formatRoutesHuman,
  routesUsage,
  serveUsage,
} from "../src/serve-cli.js";

const distRoot = fileURLToPath(new URL("../", import.meta.url));
const servableIndex = pathToFileURL(join(distRoot, "src", "index.js")).href;
const servableCli = join(distRoot, "src", "cli.js");
const fixturesRoot = join(distRoot, ".cli-fixtures");
mkdirSync(fixturesRoot, { recursive: true });

// Imports the runtime by its public name, so this also checks the `./cli`
// export (a package can import itself by name from inside its own tree).
const acmeBin = `import { CliError, EXIT, serveCommand, serveUsage } from "@johnhenry/servable/cli";
const fatal = process.env.ACME_FATAL === "1";
process.exitCode = await serveCommand(process.argv.slice(3), {
  label: "acme",
  usage: serveUsage("acme", "<Acme>...</Acme>"),
  reloadParam: "acme-reload",
  loadFailedMessage: "the acme failed to load",
  compileHint: "export default await compile(<Acme>...</Acme>)",
  errorCodes: { E_ACME: EXIT.LISTEN },
  renderers: { custom: (fields, label) => ({ to: "stdout", text: label + ": custom " + fields.n + "\\n" }) },
  afterLoad: (_app, reporter) => reporter.event("custom", { n: 1 }),
  requestError: (error, reporter) => {
    if (error?.message !== "upstream down") return undefined;
    reporter.event("error", { code: "E_ACME_UPSTREAM", message: "mapped", fatal: false });
    return new Response("Bad Gateway", { status: 502 });
  },
  ...(fatal ? { load: async () => { throw new CliError("E_ACME", "custom fatal"); } } : {}),
});
process.exit();
`;

function appSource(prelude = ""): string {
  return `import { Router, Route, compile } from ${JSON.stringify(servableIndex)};
import { url as depUrl } from "./dep.mjs";
${prelude}
export default await compile(Router({ children: [
  Route({ path: "/dep", method: "GET", handler: () => new Response(depUrl) }),
  Route({ path: "/upstream", method: "GET", handler: () => { throw new Error("upstream down"); } }),
  Route({ path: "/boom", method: "GET", handler: () => { throw new Error("kaboom"); } }),
] }));
`;
}

interface Proc {
  stdout: () => string;
  stderr: () => string;
  events: () => Record<string, unknown>[];
  url(): Promise<string>;
  waitFor(pred: () => boolean, what: string): Promise<void>;
  kill(): void;
  exit: Promise<number | null>;
}

function start(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Proc {
  const child = spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const events = () =>
    stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const waitFor = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}; stdout: ${stdout}; stderr: ${stderr}`);
  };
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    events,
    exit,
    waitFor,
    kill: () => child.kill("SIGKILL"),
    async url() {
      let found: string | undefined;
      await waitFor(() => {
        found = /listening on (http:\/\/\S+\/)/.exec(stdout + stderr)?.[1] ?? (events().filter((e) => e.event === "ready").at(-1)?.url as string | undefined);
        return found !== undefined;
      }, "ready");
      return found!;
    },
  };
}

function setup(): { dir: string; acme: string; mod: string; dep: string } {
  const dir = mkdtempSync(join(fixturesRoot, "hooks-"));
  const acme = join(dir, "acme.mjs");
  writeFileSync(acme, acmeBin);
  const dep = join(dir, "dep.mjs");
  writeFileSync(dep, `export const url = import.meta.url;\n`);
  const mod = join(dir, "app.mjs");
  writeFileSync(mod, appSource());
  return { dir, acme, mod, dep };
}

test("#17 hooks, --json: afterLoad event, requestError mapping (and the default E_REQUEST otherwise)", async () => {
  const { dir, acme, mod } = setup();
  const p = start(acme, ["serve", mod, "--port", "0", "--json"]);
  try {
    const url = await p.url();
    const names = p.events().map((e) => e.event);
    assert.ok(names.indexOf("custom") >= 0 && names.indexOf("custom") < names.indexOf("ready"), names.join(","));
    // #21: an embedder's afterLoad replaces the default `routes` event.
    assert.ok(!names.includes("routes"), names.join(","));
    const mapped = await fetch(`${url}upstream`);
    assert.deepEqual([mapped.status, await mapped.text()], [502, "Bad Gateway"]);
    const boom = await fetch(`${url}boom`);
    assert.equal(boom.status, 500);
    await p.waitFor(() => p.events().filter((e) => e.event === "request").length === 2, "two requests");
    const errors = p.events().filter((e) => e.event === "error");
    assert.deepEqual(errors.map((e) => e.code), ["E_ACME_UPSTREAM", "E_REQUEST"]);
    for (const e of p.events()) assert.equal(e.v, 1);
  } finally {
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#17 hooks, human: label, extra renderer, usage, compile hint, extra fatal error code", async () => {
  const { dir, acme, mod } = setup();
  const p = start(acme, ["serve", mod, "--port", "0"]);
  try {
    const url = await p.url();
    assert.match(p.stdout(), /^acme: custom 1\nacme: listening on http:\/\/127\.0\.0\.1:\d+\/\n/);
    await fetch(`${url}upstream`);
    await p.waitFor(() => /E_ACME_UPSTREAM/.test(p.stderr()), "mapped error line");
    assert.match(p.stderr(), /^acme: error E_ACME_UPSTREAM: mapped$/m);
  } finally {
    p.kill();
  }
  try {
    const help = start(acme, ["serve", "--help"]);
    assert.equal(await help.exit, 0);
    assert.equal(help.stdout(), serveUsage("acme", "<Acme>...</Acme>"));
    assert.match(help.stdout(), /^Usage: acme serve <module> \[options\]\n\nServe the compiled app a module default-exports \(export default await compile\(<Acme>\.\.\.<\/Acme>\)\)\.\n/);

    const usage = start(acme, ["serve"]);
    assert.equal(await usage.exit, EXIT.USAGE);
    assert.match(usage.stderr(), /^Usage: acme serve/);
    assert.match(usage.stderr(), /acme: error E_USAGE: missing <module>/);

    const notApp = join(dir, "not-app.mjs");
    writeFileSync(notApp, `export default 1;\n`);
    const na = start(acme, ["serve", notApp, "--json", "--port", "0"]);
    assert.equal(await na.exit, EXIT.MODULE);
    assert.match(String(na.events()[0].message), /expected a compiled app -- export default await compile\(<Acme>\.\.\.<\/Acme>\)$/);

    const fatal = start(acme, ["serve", mod, "--json", "--port", "0"], { ACME_FATAL: "1" });
    assert.equal(await fatal.exit, EXIT.LISTEN, "E_ACME maps to the exit code errorCodes gave it");
    assert.deepEqual(fatal.events().map((e) => [e.event, e.code ?? e.exitCode]), [["error", "E_ACME"], ["stopped", EXIT.LISTEN]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#17 hooks, --watch: the 500 page's text and the reload query parameter", async () => {
  const { dir, acme, mod } = setup();
  writeFileSync(mod, `export default ;\n`);
  const p = start(acme, ["serve", mod, "--port", "0", "--watch"]);
  try {
    const url = await p.url();
    const broken = await fetch(`${url}dep`);
    assert.equal(broken.status, 500);
    assert.match(await broken.text(), /^acme: the acme failed to load\n\nE_MODULE_LOAD: /);
    writeFileSync(mod, appSource());
    let body = "";
    for (let i = 0; i < 80 && !body.includes("acme-reload="); i++) {
      const res = await fetch(`${url}dep`);
      body = res.status === 200 ? await res.text() : "";
      if (!body.includes("acme-reload=")) await new Promise((r) => setTimeout(r, 50));
    }
    // The dependency (not only the entry) was re-imported under acme's parameter, not servable's.
    assert.match(body, /dep\.mjs\?acme-reload=\d+$/);
    assert.doesNotMatch(body, /servable-reload/);
  } finally {
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#17 defaults are servable's own (the servable bin passes no hooks)", async () => {
  assert.equal(SERVE_USAGE, serveUsage());
  assert.match(SERVE_USAGE, /^Usage: servable serve <module> \[options\]\n\nServe the compiled app a module default-exports \(export default await compile\(\.\.\.\)\)\.\n/);
  assert.equal(GENERATION_PARAM, "servable-reload");
  assert.equal(DEFAULT_COMPILE_HINT, "export default await compile(<Router>...</Router>)");
  assert.equal(DEFAULT_LOAD_FAILED_MESSAGE, "the app failed to load");
  const body = await (await brokenApp(new CliError("E_MODULE_LOAD", "x")).fetch(new Request("http://h/"))).text();
  assert.equal(body, "servable: the app failed to load\n\nE_MODULE_LOAD: x\n");

  const { dir, mod } = setup();
  writeFileSync(mod, `export default ;\n`);
  const p = start(servableCli, ["serve", mod, "--port", "0", "--watch"]);
  try {
    const url = await p.url();
    assert.match(p.stderr(), /^servable: listening on http:\/\/127\.0\.0\.1:\d+\/ \(app failed to load; serving 500 until the next good save\)$/m);
    assert.match(await (await fetch(url)).text(), /^servable: the app failed to load\n\n/);
    writeFileSync(mod, appSource());
    let body = "";
    for (let i = 0; i < 80 && !body.includes("servable-reload="); i++) {
      const res = await fetch(`${url}dep`);
      body = res.status === 200 ? await res.text() : "";
      if (!body.includes("servable-reload=")) await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(body, /dep\.mjs\?servable-reload=\d+$/);
  } finally {
    p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#17 createReporter: renderers add or override human output only; exitCodeFor", () => {
  const capture = () => {
    const stream = new PassThrough();
    let text = "";
    stream.setEncoding("utf8").on("data", (d: string) => (text += d));
    return { stream, text: () => text };
  };
  const out = capture();
  const err = capture();
  const human = createReporter(false, {
    label: "gw",
    out: out.stream,
    err: err.stream,
    renderers: { routes: (f) => ({ to: "stdout", text: `routes ${f.count}\n` }), stopped: () => undefined, reloading: (_f, label) => ({ to: "stderr", text: `${label} reloads\n` }) },
  });
  human.event("routes", { count: 2 });
  human.event("reloading", {});
  human.event("other", { a: 1 });
  human.event("ready", { url: "http://x/", ok: true });
  assert.equal(out.text(), "routes 2\ngw: listening on http://x/\n");
  assert.equal(err.text(), 'gw reloads\ngw: other {"a":1}\n');

  const jsonOut = capture();
  const json = createReporter(true, { out: jsonOut.stream, renderers: { routes: () => ({ to: "stdout", text: "never" }) } });
  json.event("routes", { count: 2 });
  const parsed = JSON.parse(jsonOut.text());
  assert.deepEqual([parsed.v, parsed.event, parsed.count], [1, "routes", 2]);

  // The positional form still works.
  const legacy = capture();
  createReporter(false, "old", legacy.stream, legacy.stream).event("warning", { message: "m" });
  assert.equal(legacy.text(), "old: warning: m\n");

  assert.equal(exitCodeFor("E_LISTEN"), EXIT.LISTEN);
  assert.equal(exitCodeFor("E_UPSTREAM"), EXIT.INTERNAL);
  assert.equal(exitCodeFor("E_UPSTREAM", { E_UPSTREAM: 9 }), 9);
  assert.equal(exitCodeFor("E_LISTEN", { E_LISTEN: 7 }), 7);
  assert.equal(exitCodeFor("toString"), EXIT.INTERNAL);
  assert.equal(exitCodeFor(undefined), EXIT.INTERNAL);
  for (const [code, exit] of Object.entries(ERROR_CODES)) assert.equal(exitCodeFor(code), exit);
});

test("#21 routes: the default human rendering, and routesCommand() with an embedder's hooks", async () => {
  const fields = {
    hosts: [
      { hostname: "*", routes: [{ path: "/", methods: ["GET", "HEAD"] }, { path: "/old", methods: ["*"], redirect: "/" }] },
      { hostname: "a.localhost", routes: [{ path: "/a", methods: ["POST"] }] },
    ],
    backends: [{ hostname: "*", path: "/api/*", url: "http://127.0.0.1:9/" }],
  };
  const text = "(any host)\n  GET,HEAD /\n  *        /old -> /\na.localhost\n  POST     /a\nbackends:\n  /api/* -> http://127.0.0.1:9/\n";
  assert.equal(formatRoutesHuman(fields), text);
  const out = new PassThrough();
  let written = "";
  out.setEncoding("utf8").on("data", (d: string) => (written += d));
  createReporter(false, { out, err: out }).event("routes", fields);
  assert.equal(written, text);
  assert.match(routesUsage("acme", "the acme routes"), /^Usage: acme routes <module> \[--json\]\n\nPrint the acme routes, without serving it\.\n/);

  const { dir, mod } = setup();
  const bin = join(dir, "acme-routes.mjs");
  writeFileSync(
    bin,
    `import { routesCommand } from "@johnhenry/servable/cli";
process.exitCode = await routesCommand(process.argv.slice(2), {
  label: "acme",
  usage: "acme usage\\n",
  routesUnknownMessage: "not an acme app",
  renderers: { routes: (f) => ({ to: "stdout", text: "acme " + f.hosts.length + "\\n" }) },
});
process.exit();
`,
  );
  const handMade = join(dir, "hand.mjs");
  writeFileSync(handMade, `export default { fetch: async () => new Response(""), warnings: [] };\n`);
  const run = (args: string[]) => {
    const p = start(bin, args);
    return p.exit.then((code) => ({ code, stdout: p.stdout(), stderr: p.stderr() }));
  };
  try {
    assert.deepEqual(await run([mod]), { code: 0, stdout: "acme 1\n", stderr: "" });
    const unknown = await run([handMade]);
    assert.equal(unknown.stdout, "acme 0\n");
    assert.equal(unknown.stderr, "acme: warning: not an acme app\n");
    const usage = await run([]);
    assert.equal(usage.code, 2);
    assert.equal(usage.stderr, "acme usage\nacme: error E_USAGE: missing <module>\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
