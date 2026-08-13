import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR, textOf, typeboxValueModule } from "./_test-helpers.mjs";

const { tool } = await loadExtensionTool(join(EXT_DIR, "web-search.ts"));
const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
  return () => (globalThis.fetch = realFetch);
}

function searxngResponse(results) {
  return { ok: true, status: 200, json: async () => ({ results }) };
}

test("query is encoded and sent to the local SearXNG JSON API", async () => {
  let seen;
  const restore = stubFetch(async (url, init) => {
    seen = { url, init };
    return searxngResponse([]);
  });
  try {
    await tool.execute("t1", { query: "rust simd & memchr" });
  } finally {
    restore();
  }
  assert.match(seen.url, /^http:\/\/127\.0\.0\.1:8888\/search\?q=rust%20simd%20%26%20memchr&format=json$/);
  assert.equal(seen.init.headers.Accept, "application/json");
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test("results map to title/url/snippet with tags stripped and snippet capped", async () => {
  const restore = stubFetch(async () =>
    searxngResponse([
      { title: "memchr", url: "https://crates.io/crates/memchr", content: "  <b>SIMD</b>   string\nsearch  " },
      { title: "long", url: "https://x.example/", content: "y".repeat(500) },
    ]),
  );
  try {
    const result = await tool.execute("t2", { query: "q" });
    const parsed = JSON.parse(textOf(result));
    assert.deepEqual(parsed[0], { title: "memchr", url: "https://crates.io/crates/memchr", snippet: "SIMD string search" });
    assert.equal(parsed[1].snippet.length, 300);
    assert.deepEqual(result.details.results, parsed);
  } finally {
    restore();
  }
});

test("maxResults slices, default is 5", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://x.example/${i}`, content: "" }));
  const restore = stubFetch(async () => searxngResponse(many));
  try {
    const five = JSON.parse(textOf(await tool.execute("t3", { query: "q" })));
    assert.equal(five.length, 5);
    const two = JSON.parse(textOf(await tool.execute("t4", { query: "q", maxResults: 2 })));
    assert.equal(two.length, 2);
  } finally {
    restore();
  }
});

test("missing fields degrade to empty strings, empty results say so", async () => {
  const restore = stubFetch(async () => searxngResponse([{}]));
  try {
    const parsed = JSON.parse(textOf(await tool.execute("t5", { query: "q", maxResults: 1 })));
    assert.deepEqual(parsed[0], { title: "", url: "", snippet: "" });
  } finally {
    restore();
  }
  const restoreEmpty = stubFetch(async () => searxngResponse([]));
  try {
    assert.equal(textOf(await tool.execute("t6", { query: "q" })), "no results");
  } finally {
    restoreEmpty();
  }
});

test("SearXNG being down surfaces as a loud error", async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }));
  try {
    await assert.rejects(tool.execute("t7", { query: "q" }), /SearXNG search failed: HTTP 502/);
  } finally {
    restore();
  }
  const restoreRefused = stubFetch(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8888");
  });
  try {
    await assert.rejects(tool.execute("t8", { query: "q" }), /ECONNREFUSED/);
  } finally {
    restoreRefused();
  }
});

test("schema requires query and bounds maxResults", async () => {
  const { Value } = await typeboxValueModule();
  assert.equal(Value.Check(tool.parameters, { query: "x" }), true);
  assert.equal(Value.Check(tool.parameters, {}), false);
  assert.equal(Value.Check(tool.parameters, { query: "x", maxResults: 21 }), false);
  assert.equal(Value.Check(tool.parameters, { query: "x", maxResults: 1 }), true);
});
