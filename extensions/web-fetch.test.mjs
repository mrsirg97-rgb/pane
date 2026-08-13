import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR, textOf } from "./_test-helpers.mjs";

process.env.PI_WEB_FETCH_PROXY = "";
const { tool, exports: ext } = await loadExtensionTool(join(EXT_DIR, "web-fetch.ts"));
const { ipIsPrivate, htmlToText, capChars, extractReadable, fetchGuarded, buildExecute } = ext;

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "10.9.8.7", family: 4 }];

function htmlResponse(body, over = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...over },
  });
}

test("ipIsPrivate: v4 table", () => {
  const priv = ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.9.9", "192.0.0.170",
    "198.18.0.1", "224.0.0.1", "255.255.255.255"];
  const pub = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "198.20.0.1"];
  for (const ip of priv) assert.equal(ipIsPrivate(ip), true, `${ip} must be private`);
  for (const ip of pub) assert.equal(ipIsPrivate(ip), false, `${ip} must be public`);
});

test("ipIsPrivate: v6 table", () => {
  const priv = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "FEB0::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1"];
  const pub = ["2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8", "fec0::1"];
  for (const ip of priv) assert.equal(ipIsPrivate(ip), true, `${ip} must be private`);
  for (const ip of pub) assert.equal(ipIsPrivate(ip), false, `${ip} must be public`);
});

test("non-http(s) schemes are refused", async () => {
  for (const url of ["file:///etc/passwd", "ftp://x.example/", "gopher://x.example/"]) {
    await assert.rejects(fetchGuarded(url, { lookup: publicLookup }), /only http/i);
  }
});

test("private hosts are refused before any connection", async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return htmlResponse("x"); };
  await assert.rejects(
    fetchGuarded("http://internal.example/", { fetchImpl, lookup: privateLookup }),
    /private|refused/i,
  );
  assert.equal(called, 0);
});

test("redirects are followed and each hop re-guarded", async () => {
  const hops = [];
  const fetchImpl = async (url) => {
    hops.push(url);
    if (hops.length === 1) return new Response(null, { status: 302, headers: { location: "/moved" } });
    return htmlResponse("<p>landed</p>");
  };
  const r = await fetchGuarded("https://site.example/start", { fetchImpl, lookup: publicLookup });
  assert.deepEqual(hops, ["https://site.example/start", "https://site.example/moved"]);
  assert.equal(r.finalUrl, "https://site.example/moved");
  assert.match(r.body, /landed/);
});

test("a redirect into private space is refused", async () => {
  const lookup = async (host) => (host === "evil.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "169.254.169.254", family: 4 }]);
  const fetchImpl = async (url) =>
    url.includes("evil")
      ? new Response(null, { status: 302, headers: { location: "http://metadata.internal/latest" } })
      : htmlResponse("secret");
  await assert.rejects(
    fetchGuarded("http://evil.example/", { fetchImpl, lookup }),
    /private|refused/i,
  );
});

test("redirect loops stop at the hop cap", async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "/again" } });
  await assert.rejects(
    fetchGuarded("https://loop.example/", { fetchImpl, lookup: publicLookup }),
    /redirect/i,
  );
});

test("an oversized Content-Length is refused before download", async () => {
  const fetchImpl = async () => htmlResponse("tiny", { "content-length": String(50 * 1024 * 1024) });
  await assert.rejects(
    fetchGuarded("https://big.example/", { fetchImpl, lookup: publicLookup }),
    /too large/i,
  );
});

test("the body stream is capped even when headers lie", async () => {
  const fetchImpl = async () => htmlResponse("a".repeat(64 * 1024));
  const r = await fetchGuarded("https://liar.example/", { fetchImpl, lookup: publicLookup, maxBytes: 1024 });
  assert.equal(r.bodyTruncated, true);
  assert.ok(r.body.length <= 2048, `capped body is ${r.body.length} chars`);
});

test("binary content types are refused", async () => {
  const fetchImpl = async () => new Response("x", { status: 200, headers: { "content-type": "image/png" } });
  await assert.rejects(
    fetchGuarded("https://img.example/a.png", { fetchImpl, lookup: publicLookup }),
    /content type/i,
  );
});

test("non-2xx status is an error", async () => {
  const fetchImpl = async () => new Response("gone", { status: 404, headers: { "content-type": "text/html" } });
  await assert.rejects(
    fetchGuarded("https://site.example/missing", { fetchImpl, lookup: publicLookup }),
    /404/,
  );
});

test("htmlToText strips script/style, keeps structure, decodes entities", () => {
  const html = `<html><head><title>T</title><style>p{}</style><script>bad()</script></head>
    <body><h1>Header</h1><p>alpha &amp; beta&nbsp;&lt;3</p><ul><li>one</li><li>two</li></ul></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /bad\(\)|p\{\}/);
  assert.match(text, /Header\n/);
  assert.match(text, /alpha & beta <3/);
  assert.match(text, /one\ntwo/);
});

test("capChars truncates loudly with the true total", () => {
  const capped = capChars("x".repeat(500), 100);
  assert.ok(capped.length < 500);
  assert.match(capped, /truncated.*100.*500/is);
  assert.equal(capChars("short", 100), "short");
});

test("extractReadable falls back to htmlToText when trafilatura is unavailable", async () => {
  const text = await extractReadable("<body><p>plain fallback</p></body>", { trafilatura: null });
  assert.match(text, /plain fallback/);
  const missing = await extractReadable("<body><p>still works</p></body>", { trafilatura: "/nonexistent/bin" });
  assert.match(missing, /still works/);
});

test("e2e: real server through the seam, html extracted", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/hop") {
      res.writeHead(302, { location: "/page" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><script>x()</script><article><p>real e2e body</p></article></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const exec = buildExecute({ lookup: publicLookup });
    const result = await exec("t1", { url: `http://127.0.0.1:${port}/hop` });
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /real e2e body/);
    assert.doesNotMatch(textOf(result), /x\(\)/);
    assert.equal(result.details.finalUrl, `http://127.0.0.1:${port}/page`);
  } finally {
    server.close();
  }
});

test("e2e: timeout surfaces as a clear error", async () => {
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const exec = buildExecute({ lookup: publicLookup });
    const result = await exec("t2", { url: `http://127.0.0.1:${port}/slow`, timeoutMs: 300 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /timed out/i);
  } finally {
    server.close();
  }
});

test("execute reports guard refusals as tool errors, not throws", async () => {
  const exec = buildExecute({ lookup: privateLookup });
  const result = await exec("t3", { url: "http://internal.example/" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /private|refused/i);
});

test("tool registration: name, required url, guidelines exist", async () => {
  assert.equal(tool.name, "web_fetch");
  assert.equal(tool.parameters.required?.includes("url"), true);
  const { Value } = await import("node:module").then(() => import("./_test-helpers.mjs")).then((h) => h.typeboxValueModule());
  assert.equal(Value.Check(tool.parameters, { url: "https://x.example/" }), true);
  assert.equal(Value.Check(tool.parameters, {}), false);
});
