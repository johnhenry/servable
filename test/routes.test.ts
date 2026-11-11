// Issue #21: what an app answers, as data -- `describeRoutes()` on a
// compiled app, `describeRoutes(tree)`, `describeLayout(layout(...))`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dir, File } from "@johnhenry/fileable";
import { compile } from "../src/compile.js";
import { Group, Host, NotFound, Redirect, Route, Router } from "../src/components.js";
import { describeLayout, describeRoutes, layout, resolve, build, cloneDescriptorTree } from "../src/index.js";
import type { RouteEntry } from "../src/index.js";

const ok = () => new Response("ok");

function tree() {
  return Router({
    children: [
      Route({ path: "/", children: ["home"] }),
      Group({
        prefix: "/api",
        children: [
          Route({ path: "/", handler: ok }),
          Route({ path: "/users/:id", handler: ok }),
          Route({ path: "/users/:id", method: "delete", handler: ok }),
          NotFound({ children: ["no such API"] }),
        ],
      }),
      Route({ path: "/logo", src: new Blob(["png"]) }),
      Group({ prefix: "/files", children: [Route({ path: "/*", handler: ok })] }),
      Redirect({ from: "/old", to: "/" }),
      Host({ name: "admin.localhost", children: [Route({ path: "/dash", children: ["dash"] })] }),
      Host({ pattern: "*.example.com", children: [NotFound({ handler: () => new Response("x", { status: 404 }) })] }),
    ],
  });
}

const byPath = (routes: RouteEntry[], path: string) => routes.find((r) => r.path === path);

test("#21 describeRoutes(): methods, kind, params, Group prefix, redirects, hosts and NotFound", async () => {
  const app = await compile(tree());
  const report = await app.describeRoutes();
  assert.deepEqual(report.backends, []);
  assert.equal(report.notFound, true);
  assert.deepEqual(
    report.hosts.map((h) => [h.hostname, h.pattern]),
    [["*", true], ["admin.localhost", false], ["*.example.com", true]],
  );
  const any = report.hosts[0];
  assert.deepEqual(any.notFoundPrefixes, ["/api"]);
  assert.deepEqual(byPath(any.routes, "/"), { path: "/", methods: ["GET"], kind: "static", params: [], hasParams: false, prefix: "" });
  // A Group's own path="/" is listed at the prefix, not as a URLPattern `{/}?`.
  assert.deepEqual(byPath(any.routes, "/api"), { path: "/api", methods: ["GET"], kind: "handler", params: [], hasParams: false, prefix: "/api" });
  assert.deepEqual(byPath(any.routes, "/api/users/:id"), {
    path: "/api/users/:id",
    methods: ["GET", "DELETE"],
    kind: "handler",
    params: ["id"],
    hasParams: true,
    prefix: "/api",
  });
  assert.equal(byPath(any.routes, "/logo")!.kind, "src");
  assert.deepEqual(byPath(any.routes, "/files/*"), { path: "/files/*", methods: ["GET"], kind: "handler", params: [], hasParams: true, prefix: "/files" });
  assert.deepEqual(byPath(any.routes, "/old"), {
    path: "/old",
    methods: ["*"],
    kind: "redirect",
    params: [],
    hasParams: false,
    prefix: "",
    redirect: "/",
    status: 301,
  });
  assert.deepEqual(report.hosts[1].routes.map((r) => r.path), ["/dash"]);
  assert.deepEqual(report.hosts[1].notFoundPrefixes, []);
  // A Host with only a NotFound still shows up, with no routes.
  assert.deepEqual(report.hosts[2].routes, []);
  assert.deepEqual(report.hosts[2].notFoundPrefixes, ["/"]);
});

test("#21 a compiled app still looks like { fetch, warnings }; describeRoutes is non-enumerable", async () => {
  const app = await compile(Router({ children: [Route({ path: "/", children: ["hi"] })] }));
  assert.deepEqual(Object.keys(app), ["fetch", "warnings"]);
  assert.equal(typeof app.describeRoutes, "function");
  assert.equal(JSON.stringify(Object.keys({ ...app })), '["fetch","warnings"]');
});

test("#21 no NotFound anywhere: notFound false", async () => {
  const app = await compile(Router({ children: [Route({ path: "/", children: ["hi"] })] }));
  const report = await app.describeRoutes();
  assert.equal(report.notFound, false);
  assert.deepEqual(report.hosts[0].notFoundPrefixes, []);
});

test("#21 a mounted fileable tree's files are listed as kind mount, at their real paths", async () => {
  const site = Dir({
    name: "site",
    children: [File({ name: "index.html", children: ["<h1>hi</h1>"] }), File({ name: "about.html", children: ["about"] })],
  });
  const app = await compile(Router({ children: [Group({ prefix: "/docs", from: site })] }));
  const routes = (await app.describeRoutes()).hosts[0].routes;
  assert.deepEqual(
    routes.map((r) => [r.path, r.kind, r.prefix]).sort(),
    [
      ["/docs/site", "mount", "/docs"],
      ["/docs/site/about.html", "mount", "/docs"],
      ["/docs/site/index.html", "mount", "/docs"],
    ],
  );
  // Every listed literal path really answers.
  for (const r of routes) assert.equal((await app.fetch(new Request(`http://x${r.path}`))).status, 200, r.path);
});

test("#21 describeRoutes(tree) and describeLayout() agree with the compiled app's report", async () => {
  const fromApp = await (await compile(tree())).describeRoutes();
  assert.deepEqual(await describeRoutes(tree()), fromApp);
  const laidOut = layout(await resolve(build(cloneDescriptorTree(tree()))));
  assert.deepEqual(describeLayout(laidOut), fromApp);
});
