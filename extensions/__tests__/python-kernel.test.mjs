import { after, test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadExtensionTool,
  textOf,
  EXT_DIR,
  scratchDir,
} from "./_test-helpers.mjs";

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
  await kernel.send({ code: "1" }, 5000);
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

test("an unexpected mid-call death is announced to the dying call and the next call", async () => {
  const r1 = await run({ code: "import os; os._exit(9)" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /kernel exited \(code 9\)/);
  const r2 = await run({ code: "1 + 1" });
  assert.equal(r2.isError, false);
  const text = textOf(r2);
  assert.match(
    text,
    /note: fresh kernel; previous kernel exited \(code 9\); all previous variables are gone/,
  );
  assert.ok(
    text.indexOf("note:") < text.indexOf("Out["),
    "note must render first",
  );
  assert.match(text, /Out\[.*\]: 2/);
});

test("a quiescent death between calls is announced on the next call, once", async () => {
  const kernel = new ext.Kernel();
  try {
    await kernel.send({ code: "seed = 1" }, 5000);
    const procRef = kernel.proc;
    procRef.kill("SIGKILL");
    await new Promise((resolve) => procRef.once("exit", resolve));
    const r = await kernel.send({ code: "1 + 1" }, 5000);
    assert.equal(r.ok, true);
    assert.match(
      r.note ?? "",
      /note: fresh kernel; previous kernel exited \(signal SIGKILL\); all previous variables are gone/,
    );
    const again = await kernel.send({ code: "1 + 1" }, 5000);
    assert.equal(again.note, undefined, "note is one-shot");
  } finally {
    kernel.shutdown();
  }
});

test("a deliberate timeout restart does not produce a death note", async () => {
  const r = await run({ code: "import time; time.sleep(30)", timeoutMs: 1500 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /timed out/);
  const ok = await run({ code: "1 + 1" });
  assert.equal(ok.isError, false);
  assert.doesNotMatch(textOf(ok), /note: fresh kernel/);
  assert.match(textOf(ok), /Out\[.*\]: 2/);
});

test("constructor options select interpreter and host (injection seam)", async () => {
  const dir = scratchDir();
  const host = join(dir, "fake-host.py");
  writeFileSync(
    host,
    [
      "import json, sys",
      "for line in sys.stdin:",
      "    line = line.strip()",
      "    if not line: continue",
      "    req = json.loads(line)",
      "    resp = {'ok': True, 'out': 'fake-pong', 'err': '', 'result': None, 'error': None}",
      "    resp['id'] = req.get('id')",
      "    print(json.dumps(resp), flush=True)",
    ].join("\n"),
  );
  const kernel = new ext.Kernel({ python: "python3", host });
  try {
    const r = await kernel.send({ code: "whatever" }, 5000);
    assert.equal(r.ok, true);
    assert.equal(r.out, "fake-pong");
  } finally {
    kernel.shutdown();
  }
});

// A protocol host whose behavior is steered by env, with a per-spawn counter
// file in PANE_FAKE_STATE_DIR. Deterministic dirty-death scenarios, no sleeps.
const FAKE_HOST_SRC = [
  "import json, os, sys",
  "state = os.environ.get('PANE_FAKE_STATE_DIR')",
  "mode = os.environ.get('PANE_FAKE_MODE', 'normal')",
  "count = 0",
  "if state:",
  "    p = os.path.join(state, 'count')",
  "    try: count = int(open(p).read() or 0)",
  "    except Exception: count = 0",
  "    open(p, 'w').write(str(count + 1))",
  "if mode == 'partial' and count == 0:",
  "    sys.stdout.write('{\"partial')",
  "    sys.stdout.flush()",
  "    sys.exit(0)",
  "if mode == 'stderr' and count == 0:",
  "    sys.stderr.write('old-error\\n')",
  "    sys.stderr.flush()",
  "    sys.exit(4)",
  "if mode == 'stderr' and count >= 1:",
  "    sys.exit(5)",
  "for line in sys.stdin:",
  "    line = line.strip()",
  "    if not line: continue",
  "    req = json.loads(line)",
  "    resp = {'ok': True, 'out': 'fake-ok', 'err': '', 'result': None, 'error': None}",
  "    resp['id'] = req.get('id')",
  "    print(json.dumps(resp), flush=True)",
].join("\n");

function fakeKernel(mode) {
  const dir = scratchDir();
  const host = join(dir, "fake-host.py");
  writeFileSync(host, FAKE_HOST_SRC);
  process.env.PANE_FAKE_STATE_DIR = dir;
  process.env.PANE_FAKE_MODE = mode;
  return new ext.Kernel({ python: "python3", host });
}

function clearFakeEnv() {
  delete process.env.PANE_FAKE_STATE_DIR;
  delete process.env.PANE_FAKE_MODE;
}

test("a dirty death leaves no stale buffer that swallows the next kernel's reply", async () => {
  const kernel = fakeKernel("partial");
  try {
    const first = await kernel.send({ code: "a" }, 5000);
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /kernel exited \(code 0\)/);
    const second = await kernel.send({ code: "b" }, 3000);
    assert.equal(
      second.ok,
      true,
      `stale buffer swallowed the reply: ${second.error}`,
    );
    assert.equal(second.out, "fake-ok");
  } finally {
    clearFakeEnv();
    kernel.shutdown();
  }
});

test("a dead kernel's stderr does not leak into the next kernel's death message", async () => {
  const kernel = fakeKernel("stderr");
  try {
    const first = await kernel.send({ code: "a" }, 5000);
    assert.equal(first.ok, false);
    assert.match(first.error ?? "", /kernel exited \(code 4\)/);
    assert.match(first.error ?? "", /old-error/);
    const second = await kernel.send({ code: "b" }, 5000);
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /kernel exited \(code 5\)/);
    assert.doesNotMatch(second.error ?? "", /old-error/);
  } finally {
    clearFakeEnv();
    kernel.shutdown();
  }
});

test("timeout message describes the lazy restart accurately", async () => {
  const r = await run({ code: "import time; time.sleep(30)", timeoutMs: 1500 });
  assert.equal(r.isError, true);
  assert.match(
    textOf(r),
    /will be restarted on the next call; all variables are gone/,
  );
});
