import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { serveFile } from "../src/serve-file.js";

const fixture = join(process.cwd(), "test/fixtures/range-test.txt");

test("a plain GET returns the full body with Accept-Ranges set", async () => {
  const res = await serveFile(new Request("http://x/file"), fixture);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(await res.text(), "0123456789\n");
});

test("a single-range request returns 206 with the correct byte slice", async () => {
  const res = await serveFile(new Request("http://x/file", { headers: { Range: "bytes=0-4" } }), fixture);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 0-4/11");
  assert.equal(await res.text(), "01234");
});

test("a suffix range (last N bytes) is honored", async () => {
  const res = await serveFile(new Request("http://x/file", { headers: { Range: "bytes=-3" } }), fixture);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 8-10/11");
  assert.equal(await res.text(), "89\n");
});

test("an out-of-range request returns 416 with Content-Range: bytes */size", async () => {
  const res = await serveFile(new Request("http://x/file", { headers: { Range: "bytes=1000-2000" } }), fixture);
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), "bytes */11");
});

test("HEAD returns the same headers with no body", async () => {
  const res = await serveFile(new Request("http://x/file", { method: "HEAD" }), fixture);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "11");
  assert.equal(res.body, null);
});

test("a matching If-None-Match returns 304", async () => {
  const first = await serveFile(new Request("http://x/file"), fixture);
  const etag = first.headers.get("etag")!;
  assert.ok(etag);
  const res = await serveFile(new Request("http://x/file", { headers: { "If-None-Match": etag } }), fixture);
  assert.equal(res.status, 304);
});

test("download: true sets Content-Disposition: attachment with the inferred filename", async () => {
  const res = await serveFile(new Request("http://x/file"), fixture, { download: true });
  assert.match(res.headers.get("content-disposition")!, /attachment; filename="range-test\.txt"/);
});

test("download: string overrides the filename", async () => {
  const res = await serveFile(new Request("http://x/file"), fixture, { download: "custom-name.txt" });
  assert.match(res.headers.get("content-disposition")!, /filename="custom-name\.txt"/);
});

test("a Blob source works directly, no filesystem involved", async () => {
  const blob = new Blob(["in-memory content"], { type: "text/plain" });
  const res = await serveFile(new Request("http://x/file"), blob);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "in-memory content");
});

test("a nonexistent local file rejects with a clear error", async () => {
  await assert.rejects(() => serveFile(new Request("http://x/file"), "/no/such/file.txt"));
});
