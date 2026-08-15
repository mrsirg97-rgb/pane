import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { EXT_DIR, loadExtension, scratchDir } from "./_test-helpers.mjs";

process.env.TZ = "UTC";

const runner = await loadExtension(join(EXT_DIR, "scheduler/runner.mjs"));
const coreMod = await loadExtension(join(EXT_DIR, "scheduler/core.ts"));
const store = await loadExtension(join(EXT_DIR, "scheduler/store.ts"));

const RUNNER_SH = resolve(join(EXT_DIR, "scheduler/runner.sh"));
const RUNNER_MJS = resolve(join(EXT_DIR, "scheduler/runner.mjs"));

const NOW = () => new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
const LOG_NAME = "2026-08-15T12-00-00-000Z.log";

const MODELS = [
  { id: "qwen3.8-27b", meta: { llamaswap: { aliases: ["qwen3.8"] } } },
  {
    id: "qwen3.8-27b-workers",
    meta: { llamaswap: { aliases: ["qwen3.8-workers"] } },
  },
];

function fakeCrontab(initial = "SHELL=/bin/bash\n") {
  const ct = { text: initial };
  ct.list = async () => ct.text;
  ct.install = async (t) => {
    ct.text = t;
  };
  return ct;
}

function fakeSwap(running = [], opts = {}) {
  return async (url) => {
    if (opts.fail) throw new Error(opts.fail);
    if (url.endsWith("/v1/models")) return { data: MODELS, object: "list" };
    if (url.endsWith("/running")) return { running };
    throw new Error(`unexpected url ${url}`);
  };
}

function fakeSpawn(result = { exit: 0, stdout: "hello\n", stderr: "" }) {
  const calls = [];
  const s = async (argv, o) => {
    calls.push({ argv, o });
    return result;
  };
  s.calls = calls;
  return s;
}

async function setup(job = {}) {
  const home = scratchDir();
  const cwd = job.cwd ?? "/ws/r1";
  const ct = fakeCrontab();
  const core = coreMod.createSchedulerCore({
    home,
    sessionCwd: cwd,
    session: "sess-x",
    crontab: ct,
    now: NOW,
    runnerPath: "/x/runner.sh",
  });
  const j = await core.create({
    name: "job",
    prompt: job.prompt ?? "do the thing",
    cron: job.cron ?? "0 */4 * * *",
    at: job.at,
    model: job.model ?? "qwen3.8-workers",
    busy: job.busy ?? "skip",
    cwd,
  });
  const key = j.scope === "global" ? j.id : `cwd-${store.cwdHash(cwd)}:${j.id}`;
  const dbPath =
    j.scope === "global"
      ? join(home, "global.sqlite")
      : join(home, `${store.cwdHash(cwd)}.sqlite`);
  return { home, ct, core, job: j, key, dbPath, cwd };
}

function events(dbPath, op) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT ts, args, session FROM events WHERE op = ? ORDER BY seq")
      .all(op)
      .map((r) => ({ ts: r.ts, args: JSON.parse(r.args), session: r.session }));
  } finally {
    db.close();
  }
}

function row(dbPath, id) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

function updateRow(dbPath, id, setSql) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`UPDATE jobs SET ${setSql} WHERE id = ?`).run(id);
  } finally {
    db.close();
  }
}

function fire(key, dbPath, over = {}) {
  const home = over.home ?? dbPath.slice(0, dbPath.lastIndexOf("/"));
  const ct = over.ct ?? fakeCrontab();
  const opts = {
    home,
    key,
    crontab: ct,
    fetch: fakeSwap(over.running ?? []),
    spawn: over.spawn ?? fakeSpawn(over.result),
    now: NOW,
    piBin: "pi",
    swapUrl: "http://127.0.0.1:8090",
    ...(over.failFetch
      ? { fetch: fakeSwap([], { fail: over.failFetch }) }
      : {}),
    ...over.extra,
  };
  return { promise: runner.fire(key, opts), ct, opts };
}

// ---- key parsing ----

test("parseKey: global and cwd keys; garbage refuses", () => {
  assert.deepEqual(runner.parseKey("j1"), {
    scope: "global",
    hash: null,
    id: "j1",
  });
  assert.deepEqual(runner.parseKey("cwd-b01229c83837:j42"), {
    scope: "cwd",
    hash: "b01229c83837",
    id: "j42",
  });
  assert.throws(() => runner.parseKey("garbage"), /bad key/);
  assert.throws(() => runner.parseKey("cwd-zzz:j1"), /bad key/);
});

// ---- busy matrix ----

test("own model resident (via alias) -> runs; argv, cwd, report-back, log, ok record", async () => {
  const { home, ct, key, dbPath } = await setup();
  const spawn = fakeSpawn();
  const res = await runner.fire(key, {
    home,
    key,
    crontab: ct,
    fetch: fakeSwap([{ model: "qwen3.8-27b-workers", state: "ready" }]),
    spawn,
    now: NOW,
    piBin: "pi",
    swapUrl: "http://127.0.0.1:8090",
  });
  assert.equal(res.status, "ok");

  assert.deepEqual(spawn.calls[0].argv.slice(0, 2), ["pi", "-p"]);
  const prompt = spawn.calls[0].argv[2];
  assert.ok(prompt.startsWith("do the thing"), "job prompt first");
  assert.match(prompt, /rem/i, "report-back mentions rem");
  assert.match(prompt, /cwd/i, "report-back names the job cwd scope");
  assert.deepEqual(spawn.calls[0].argv.slice(-3), [
    "--model",
    "qwen3.8-workers",
    "--no-session",
  ]);
  assert.equal(spawn.calls[0].o.cwd, "/ws/r1");

  const rec = events(dbPath, "run")[0].args;
  assert.match(rec.log, /^runs\//);
  const log = readFileSync(join(home, rec.log), "utf8");
  assert.ok(log.includes("hello"), "stdout in log");
  assert.match(log, /exit=0/);
  assert.equal(rec.status, "ok");
  assert.equal(rec.exit, 0);
  assert.equal(typeof rec.durationMs, "number");
  assert.equal(rec.reason, null);
  assert.equal(
    events(dbPath, "run")[0].session,
    null,
    "runner events are session-less",
  );

  assert.equal(row(dbPath, "j1").last_status, "ok");
  assert.ok(ct.text.includes("pane-scheduler:"), "recurring line stays");
});

test("nothing resident -> runs", async () => {
  const { home, ct, key, dbPath } = await setup();
  const { promise, opts } = fire(key, dbPath, { home, ct, running: [] });
  const res = await promise;
  assert.equal(res.status, "ok");
  assert.equal(opts.spawn.calls.length, 1);
});

test("something else resident + busy=skip -> skip record, no spawn, line untouched", async () => {
  const { home, ct, key, dbPath } = await setup();
  const {
    promise,
    ct: ct2,
    opts,
  } = fire(key, dbPath, {
    home,
    ct,
    running: [{ model: "qwen3.8-27b", state: "ready" }],
  });
  const before = ct.text;
  const res = await promise;
  assert.equal(res.status, "skip");
  assert.match(res.reason, /busy/);
  assert.equal(opts.spawn.calls.length, 0);
  assert.equal(ct2.text, before);
  const rec = events(dbPath, "run")[0].args;
  assert.equal(rec.status, "skip");
  assert.match(rec.reason, /qwen3\.8-27b/);
});

test("something else resident + busy=force -> runs and eats the eviction", async () => {
  const { home, ct, key } = await setup({ busy: "force" });
  const { promise, opts } = fire(key, null, {
    home,
    ct,
    running: [{ model: "qwen3.8-27b", state: "ready" }],
  });
  const res = await promise;
  assert.equal(res.status, "ok");
  assert.equal(opts.spawn.calls.length, 1);
});

test("busy-check fetch failure -> fail-closed skip with reason", async () => {
  const { home, ct, key, dbPath } = await setup();
  const { promise, opts } = fire(key, dbPath, {
    home,
    ct,
    failFetch: "fetch failed: ECONNREFUSED",
  });
  const res = await promise;
  assert.equal(res.status, "skip");
  assert.match(res.reason, /busy check failed/);
  assert.equal(opts.spawn.calls.length, 0);
  assert.match(events(dbPath, "run")[0].args.reason, /ECONNREFUSED/);
});

// ---- run outcomes ----

test("pi exit != 0 -> fail record with exit code; log carries stderr", async () => {
  const { home, ct, key, dbPath } = await setup();
  const { promise } = fire(key, dbPath, {
    home,
    ct,
    result: { exit: 3, stdout: "out", stderr: "boom\n" },
  });
  const res = await promise;
  assert.equal(res.status, "fail");
  const rec = events(dbPath, "run")[0].args;
  assert.equal(rec.status, "fail");
  assert.equal(rec.exit, 3);
  const log = readFileSync(join(home, rec.log), "utf8");
  assert.ok(log.includes("boom"), "stderr in log");
  assert.equal(row(dbPath, "j1").last_status, "fail");
  assert.equal(row(dbPath, "j1").last_exit, 3);
});

test("once: fire consumes the line and marks done", async () => {
  const { home, ct, key, dbPath } = await setup({
    cron: "once",
    at: "2026-08-16T03:07:00Z",
  });
  assert.ok(
    ct.text.includes("pane-scheduler:"),
    "once line present before fire",
  );
  const { promise } = fire(key, dbPath, { home, ct });
  const res = await promise;
  assert.equal(res.status, "ok");
  assert.ok(!ct.text.includes("pane-scheduler:"), "line consumed");
  assert.equal(row(dbPath, "j1").state, "done");
});

test("once with failing pi: done-with-fail, no retry", async () => {
  const { home, ct, key, dbPath } = await setup({
    cron: "once",
    at: "2026-08-16T03:07:00Z",
  });
  const { promise } = fire(key, dbPath, {
    home,
    ct,
    result: { exit: 1, stdout: "", stderr: "nope" },
  });
  const res = await promise;
  assert.equal(res.status, "fail");
  assert.equal(row(dbPath, "j1").state, "done");
  assert.ok(!ct.text.includes("pane-scheduler:"));
  assert.equal(
    events(dbPath, "run").length,
    1,
    "no retry: exactly one run record",
  );
});

// ---- zombie / drift self-heal ----

test("zombie line with missing row: line deleted, skip recorded", async () => {
  const { home, ct, key, dbPath } = await setup();
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM jobs WHERE id = 'j1'").run();
  db.close();
  const { promise } = fire(key, dbPath, { home, ct });
  const res = await promise;
  assert.equal(res.status, "skip");
  assert.match(res.reason, /no job row/);
  assert.ok(!ct.text.includes("pane-scheduler:"));
  assert.equal(events(dbPath, "run")[0].args.status, "skip");
});

test("crash window: row done but line alive -> line deleted, skip recorded", async () => {
  const { home, ct, key, dbPath } = await setup({
    cron: "once",
    at: "2026-08-16T03:07:00Z",
  });
  updateRow(dbPath, "j1", "state = 'done'");
  const { promise } = fire(key, dbPath, { home, ct });
  const res = await promise;
  assert.equal(res.status, "skip");
  assert.match(res.reason, /already done/);
  assert.ok(!ct.text.includes("pane-scheduler:"));
});

test("paused row (line drifted active): skip, line untouched for the list to flag", async () => {
  const { home, ct, key, dbPath } = await setup();
  updateRow(dbPath, "j1", "state = 'paused'");
  const { promise, ct: ct2 } = fire(key, dbPath, { home, ct });
  const before = ct.text;
  const res = await promise;
  assert.equal(res.status, "skip");
  assert.match(res.reason, /paused/);
  assert.equal(ct2.text, before);
});

// ---- logs ----

test("logs prune to the newest 20", async () => {
  const { home, ct, key, cwd } = await setup();
  const dir = join(home, "runs", `cwd-${store.cwdHash(cwd)}`, "j1");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 25; i++) {
    const d = new Date(Date.UTC(2026, 7, 14, 0, i))
      .toISOString()
      .replace(/[:.]/g, "-");
    writeFileSync(join(dir, `${d}.log`), "old");
  }
  const { promise } = fire(key, null, { home, ct });
  const res = await promise;
  assert.equal(res.status, "ok");
  const files = readdirSync(dir).filter((f) => f.endsWith(".log"));
  assert.equal(files.length, 20, "pruned to 20");
  assert.ok(files.includes(LOG_NAME), "new log kept");
  assert.ok(!files.includes("2026-08-14T00-00-00-000Z.log"), "oldest dropped");
});

// ---- lock skip (engine level) ----

test("lock-skip records a skip without touching crontab or running pi", async () => {
  const { home, ct, key, dbPath } = await setup();
  const spawn = fakeSpawn();
  const before = ct.text;
  await runner.lockSkipRecord(key, {
    home,
    key,
    crontab: ct,
    fetch: fakeSwap([]),
    spawn,
    now: NOW,
    piBin: "pi",
    swapUrl: "http://127.0.0.1:8090",
  });
  assert.equal(spawn.calls.length, 0);
  assert.equal(ct.text, before);
  const rec = events(dbPath, "run")[0].args;
  assert.equal(rec.status, "skip");
  assert.match(rec.reason, /lock held/);
});

// ---- runner.sh: real subshell, scrubbed env ----

function deployHome(home) {
  const dir = join(home, ".pi/agent/scheduler");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner.sh"), readFileSync(RUNNER_SH));
  chmodSync(join(dir, "runner.sh"), 0o755);
  writeFileSync(join(dir, "runner.mjs"), readFileSync(RUNNER_MJS));
  return dir;
}

function fakeCrontabBin(home) {
  const state = join(home, "crontab.txt");
  writeFileSync(state, "SHELL=/bin/bash\n");
  const bin = join(home, "fakecrontab");
  writeFileSync(
    bin,
    `#!/bin/sh\nstate=${state}\n[ "$1" = "-l" ] && { cat "$state"; exit 0; }\n[ "$1" = "-" ] && { cat > "$state"; exit 0; }\nexit 2\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, state };
}

function seedGlobalJob(dir, cwd) {
  const db = join(dir, "global.sqlite");
  if (existsSync(db)) throw new Error("unexpected pre-existing global store");
  const g = new DatabaseSync(db);
  g.exec(store.SCHEMA);
  g.prepare("INSERT INTO events (ts, op, args, session) VALUES (?,?,?,?)").run(
    "2026-08-15T00:00:00.000Z",
    "create",
    JSON.stringify({
      name: "job",
      prompt: "do the thing",
      cron: "0 */4 * * *",
      at: null,
      cwd,
      model: "qwen3.8-workers",
      busy: "skip",
    }),
    "sess-x",
  );
  g.prepare(
    "INSERT INTO jobs (id,name,prompt,cron,at,cwd,model,busy,state,created_seq,updated_seq) VALUES ('j1','job','do the thing','0 */4 * * *',NULL,?,?, 'skip','active',1,1)",
  ).run(cwd, "qwen3.8-workers");
  g.close();
  return db;
}

function runShell(dir, env = {}) {
  return new Promise((res) => {
    const child = spawn(join(dir, "runner.sh"), ["j1"], {
      env: { HOME: join(dir, "..", "..", ".."), PATH: "/usr/bin:/bin", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => res({ code, out, err }));
  });
}

test("runner.sh (cold shell): flock held -> skip record, exit 0, crontab untouched", async () => {
  const home = scratchDir();
  const dir = deployHome(home);
  const { state } = fakeCrontabBin(home);
  const db = seedGlobalJob(dir, "/ws/sh1");
  writeFileSync(
    state,
    `SHELL=/bin/bash\n0 */4 * * * ${join(dir, "runner.sh")} j1  # pane-scheduler:j1\n`,
  );

  const lock = join(dir, "locks/j1.lock");
  mkdirSync(join(dir, "locks"), { recursive: true });
  const holder = spawn("flock", [lock, "-c", "sleep 3"]);
  await sleep(400);
  const res = await runShell(dir, {
    PANE_CRONTAB_BIN: join(home, "fakecrontab"),
  });
  holder.kill();
  assert.equal(res.code, 0, `runner.sh exit 0 (stderr: ${res.err})`);
  const rec = events(db, "run")[0]?.args;
  assert.equal(rec?.status, "skip");
  assert.match(rec?.reason ?? "", /lock held/);
  assert.ok(
    readFileSync(state, "utf8").includes("pane-scheduler:j1"),
    "crontab untouched",
  );
});

test("runner.sh (cold shell): crontab list fails unexpectedly -> exit 1, loud, nothing recorded", async () => {
  const home = scratchDir();
  const dir = deployHome(home);
  const db = seedGlobalJob(dir, "/ws/sh3");
  const state = join(home, "crontab.txt");
  writeFileSync(
    state,
    `SHELL=/bin/bash\n0 */4 * * * ${join(dir, "runner.sh")} j1  # pane-scheduler:j1\n`,
  );
  // fake crontab that fails the way PAM would: exit 1, non-standard stderr
  const bin = join(home, "fakecrontab");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "PAM: user not authorized" >&2\nexit 1\n`,
  );
  chmodSync(bin, 0o755);

  const res = await runShell(dir, { PANE_CRONTAB_BIN: bin });
  assert.equal(res.code, 1, `expected exit 1 (stderr: ${res.err})`);
  assert.match(res.err, /crontab list failed/);
  assert.match(res.err, /PAM: user not authorized/);
  assert.equal(
    events(db, "run").length,
    0,
    "fail closed: nothing recorded, nothing installed",
  );
  assert.ok(
    readFileSync(state, "utf8").includes("pane-scheduler:j1"),
    "crontab file untouched",
  );
});

test("runner.sh (cold shell): no contention, swap down -> fail-closed skip end to end", async () => {
  const home = scratchDir();
  const dir = deployHome(home);
  const { bin, state } = fakeCrontabBin(home);
  const db = seedGlobalJob(dir, "/ws/sh2");
  writeFileSync(
    state,
    `SHELL=/bin/bash\n0 */4 * * * ${join(dir, "runner.sh")} j1  # pane-scheduler:j1\n`,
  );

  const res = await runShell(dir, {
    PANE_CRONTAB_BIN: bin,
    PANE_SWAP_URL: "http://127.0.0.1:1", // nothing listens: fail closed
  });
  assert.equal(res.code, 0, `runner.sh exit 0 (stderr: ${res.err})`);
  const rec = events(db, "run")[0]?.args;
  assert.equal(rec?.status, "skip");
  assert.match(rec?.reason ?? "", /busy check failed/);
});
