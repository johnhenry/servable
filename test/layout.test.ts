import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/build.js";
import { layout } from "../src/layout.js";
import { ErrorBoundary, Group, NotFound, Redirect, Route, Router, Use } from "../src/components.js";
import { linkTo } from "../src/api.js";
import { ServableError } from "../src/types.js";

function laidOutOf(tree: unknown) {
  return layout(build(tree));
}

test("Group prefixes accumulate through nesting", () => {
  const tree = Router({
    children: Group({
      prefix: "/api",
      children: Group({ prefix: "/v1", children: Route({ path: "/users", method: "GET", children: ["x"] }) }),
    }),
  });
  const { routes } = laidOutOf(tree);
  assert.equal(routes.length, 1);
  assert.ok(routes[0].pattern.test("http://x/api/v1/users"));
});

test('path="/" inside a Group matches both with and without a trailing slash', () => {
  const tree = Router({ children: Group({ prefix: "/users", children: Route({ path: "/", method: "GET", children: ["x"] }) }) });
  const { routes } = laidOutOf(tree);
  assert.ok(routes[0].pattern.test("http://x/users"));
  assert.ok(routes[0].pattern.test("http://x/users/"));
  assert.equal(routes[0].pattern.test("http://x/users/extra"), false);
});

test("two Routes claiming the same method+path throw", () => {
  const tree = Router({
    children: [
      Route({ path: "/dup", method: "GET", children: ["a"] }),
      Route({ path: "/dup", method: "GET", children: ["b"] }),
    ],
  });
  assert.throws(() => laidOutOf(tree), ServableError);
});

test("same path, different methods, does not collide", () => {
  const tree = Router({
    children: [
      Route({ path: "/x", method: "GET", children: ["a"] }),
      Route({ path: "/x", method: "POST", children: ["b"] }),
    ],
  });
  assert.equal(laidOutOf(tree).routes.length, 2);
});

test("Use/ErrorBoundary chain is built from containment, not sibling order", () => {
  // Two Routes at different tree depths, wrapped by Use elements that
  // don't share the same sibling position -- this guards against
  // reintroducing the position-sensitivity that was explicitly rejected
  // for <Use> during design.
  const order: string[] = [];
  const outer = async (req: Request, next: () => Promise<Response>) => {
    order.push("outer-in");
    const res = await next();
    order.push("outer-out");
    return res;
  };
  const inner = async (req: Request, next: () => Promise<Response>) => {
    order.push("inner-in");
    const res = await next();
    order.push("inner-out");
    return res;
  };
  const tree = Router({
    children: Use({
      middleware: outer,
      children: [
        Route({ path: "/shallow", method: "GET", children: ["shallow"] }),
        Use({ middleware: inner, children: Route({ path: "/deep", method: "GET", children: ["deep"] }) }),
      ],
    }),
  });
  const { routes } = laidOutOf(tree);
  const deep = routes.find((r) => (r.descriptor.props.path as string) === "/deep")!;
  assert.equal(deep.chain.length, 2);
  const shallow = routes.find((r) => (r.descriptor.props.path as string) === "/shallow")!;
  assert.equal(shallow.chain.length, 1);
});

test("ErrorBoundary requires a handler prop", () => {
  const tree = Router({ children: ErrorBoundary({ children: Route({ path: "/x", method: "GET", children: ["x"] }) }) });
  assert.throws(() => laidOutOf(tree), ServableError);
});

test("<Route> with more than one of handler/src/children throws", () => {
  const tree = Router({
    children: Route({ path: "/x", method: "GET", handler: () => new Response("x"), children: ["also this"] }),
  });
  assert.throws(() => laidOutOf(tree), ServableError);
});

test("NotFound resolves nearest-scope-wins", () => {
  const tree = Router({
    children: [
      Group({
        prefix: "/admin",
        children: [Route({ path: "/dashboard", method: "GET", children: ["ok"] }), NotFound({ children: ["admin 404"] })],
      }),
      NotFound({ children: ["root 404"] }),
    ],
  });
  const { scopes } = laidOutOf(tree);
  const admin = scopes.find((s) => s.prefix === "/admin")!;
  assert.deepEqual(admin.notFoundStatic, ["admin 404"]);
  const root = scopes.find((s) => s.prefix === "")!;
  assert.deepEqual(root.notFoundStatic, ["root 404"]);
});

test("linkTo() to a Route target resolves to its final compiled path once Layout runs", () => {
  const usersRoute = Route({ path: "/users", method: "GET", children: ["users"] });
  const tree = Router({
    children: Group({
      prefix: "/api",
      children: [
        usersRoute,
        Route({ path: "/link", method: "GET", children: [linkTo(usersRoute)] }),
      ],
    }),
  });
  const built = build(tree);
  const { routes } = layout(built);
  const linkRoute = routes.find((r) => (r.descriptor.props.path as string) === "/link")!;
  assert.equal(linkRoute.descriptor.children[0], "/api/users");
});

test("linkTo() to a Route absent from the tree throws", () => {
  const orphan = Route({ path: "/orphan", method: "GET", children: ["x"] });
  const tree = Router({ children: Route({ path: "/link", method: "GET", children: [linkTo(orphan)] }) });
  assert.throws(() => laidOutOf(tree), ServableError);
});

test("Redirect's `from` is joined with its Group's prefix", () => {
  const tree = Router({ children: Group({ prefix: "/api", children: Redirect({ from: "/old", to: "/new", status: 302 }) }) });
  const { redirects } = laidOutOf(tree);
  assert.equal(redirects.length, 1);
  assert.ok(redirects[0].pattern.test("http://x/api/old"));
});
