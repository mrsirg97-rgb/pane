import { after, test } from "node:test";
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionTool, textOf, EXT_DIR } from "./_test-helpers.mjs";

const {
  tool,
  handlers,
  exports: ext,
} = await loadExtensionTool(join(EXT_DIR, "python-kernel.ts"));
const { KERNEL_HOST } = ext;

function run(params) {
  return tool.execute("id", params, undefined, undefined, {});
}

after(() => {
  handlers.session_shutdown?.();
});

test("executes code and reports the result", async () => {
  const r = await run({ code: "6 * 7" });
  assert.equal(r.isError, false);
  assert.match(textOf(r), /Out\[.*\]: 42/);
});

test("state persists between calls", async () => {
  await run({ code: "x = 40" });
  const r = await run({ code: "x + 2" });
  assert.match(textOf(r), /Out\[.*\]: 42/);
});

test("numpy and pandas are importable", async () => {
  const r = await run({ code: "import numpy, pandas; numpy.__version__" });
  assert.equal(r.isError, false);
  assert.match(textOf(r), /Out\[.*\]: '\d+\.\d+\.\d+'/);
});

test("vars lists user-defined names only", async () => {
  const r = await run({ action: "vars" });
  assert.equal(r.isError, false);
  assert.match(textOf(r), /x: int/);
});

test("reset clears the namespace", async () => {
  await run({ action: "reset" });
  const r = await run({ action: "vars" });
  assert.match(textOf(r), /\(empty\)/);
});

test("empty call fails loudly with a clear message", async () => {
  const r = await run({});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no code supplied/);
});

test("runtime errors are reported as errors with traceback text", async () => {
  const r = await run({ code: "1 / 0" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /ZeroDivisionError/);
});

test("oversized output is clipped with an elision marker", async () => {
  const r = await run({ code: 'print("a" * 100000)' });
  assert.equal(r.isError, false);
  assert.match(textOf(r), /elided/);
  assert.ok(textOf(r).length < 20_000);
});

test("hung cell times out, kernel is restarted, caller is told", async () => {
  const r = await run({ code: "import time; time.sleep(30)", timeoutMs: 1500 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /timed out/);
  assert.match(textOf(r), /all variables are gone/);
  const ok = await run({ code: "1 + 1" });
  assert.equal(ok.isError, false);
  assert.match(textOf(ok), /Out\[.*\]: 2/);
  const vars = await run({ action: "vars" });
  assert.match(textOf(vars), /\(empty\)/);
});

test("parallel calls are routed by id, not corrupted", async () => {
  const [a, b] = await Promise.all([
    run({ code: "left = 100" }),
    run({ code: "right = 200" }),
  ]);
  assert.equal(a.isError, false);
  assert.equal(b.isError, false);
  const r = await run({ code: "left + right" });
  assert.match(textOf(r), /Out\[.*\]: 300/);
});

test("a sibling call is not collateral damage when another cell times out", async () => {
  await run({ code: "keep = 7" });
  // the hung cell restarts the kernel; the sibling must still get its own honest answer
  const [hung, sibling] = await Promise.all([
    run({ code: "import time; time.sleep(30)", timeoutMs: 1500 }),
    run({ code: "1 + 1" }),
  ]);
  assert.equal(hung.isError, true);
  assert.match(textOf(hung), /timed out/);
  assert.equal(
    sibling.isError,
    false,
    "sibling must not inherit the timeout's restart",
  );
  assert.match(textOf(sibling), /Out\[.*\]: 2/);
});

test("a queued call's timeout does not count time spent waiting", async () => {
  // 2.5s of work ahead of it, but its own 1.5s budget starts when it is written
  const [, queued] = await Promise.all([
    run({ code: "import time; time.sleep(2.5)", timeoutMs: 8000 }),
    run({ code: "9 * 9", timeoutMs: 1500 }),
  ]);
  assert.equal(
    queued.isError,
    false,
    "queue time must not be charged to the cell's timeout",
  );
  assert.match(textOf(queued), /Out\[.*\]: 81/);
});

test("an unwritable kernel fails fast instead of waiting out the timeout", async () => {
  const kernel = new ext.Kernel();
  await kernel.send({ code: "1" }, 5000); // force a spawn so there is a stdin to break
  kernel.proc.stdin.destroy();
  const started = process.hrtime.bigint();
  const r = await kernel.send({ code: "2" }, 30_000);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.ok, false);
  assert.ok(
    elapsedMs < 5000,
    `should fail fast, took ${Math.round(elapsedMs)}ms`,
  );
  kernel.shutdown();
});

test("missing host surfaces stderr diagnostics and self-heals", async () => {
  handlers.session_shutdown?.();
  const hostBak = `${KERNEL_HOST}.bak`;
  renameSync(KERNEL_HOST, hostBak);
  try {
    const r = await run({ code: "1 + 1" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /kernel exited \(code \d+\)/);
    assert.match(textOf(r), /\[stderr\]/);
  } finally {
    renameSync(hostBak, KERNEL_HOST);
  }
  const ok = await run({ code: "1 + 1" });
  assert.equal(ok.isError, false);
  assert.match(textOf(ok), /Out\[.*\]: 2/);
});
