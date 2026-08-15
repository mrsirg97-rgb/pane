import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXT_DIR, loadExtension, scratchDir } from "./_test-helpers.mjs";

// Deterministic now/cron math: pin UTC before any Date arithmetic.
process.env.TZ = "UTC";

const { createSchedulerCore } = await loadExtension(
  join(EXT_DIR, "scheduler/core.ts"),
);
const store = await loadExtension(join(EXT_DIR, "scheduler/store.ts"));
const crontabMod = await loadExtension(join(EXT_DIR, "scheduler/crontab.ts"));

const RUNNER = "/home/u/.pi/agent/scheduler/runner.sh";
const NOW = new Date(Date.UTC(2026, 7, 15, 12, 0, 0)); // Sat 2026-08-15 12:00Z

function fakeCrontab(initial = "SHELL=/bin/bash\n") {
  const ct = { text: initial };
  ct.list = async () => ct.text;
  ct.install = async (t) => {
    ct.text = t;
  };
  return ct;
}

function makeCore(sessionCwd, crontab, extra = {}) {
  const home = scratchDir();
  return {
    home,
    core: createSchedulerCore({
      home,
      sessionCwd,
      session: "sess-core",
      crontab,
      now: () => NOW,
      runnerPath: RUNNER,
      ...extra,
    }),
  };
}

// ---- create ----

test("create (cwd scope) mints j1, writes the store + tagged line, foreign lines intact", async () => {
  const ct = fakeCrontab();
  const { home, core } = makeCore("/ws/a", ct);
  const v = await core.create({
    name: "nightly",
    prompt: "do it",
    cron: "0 */4 * * *",
  });
  assert.equal(v.id, "j1");
  assert.equal(v.scope, "cwd");
  assert.equal(v.state, "active");
  assert.equal(v.drift, null);
  // next fire strictly after NOW (12:00 is an exact fire boundary of */4)
  assert.equal(
    v.nextFire,
    new Date(Date.UTC(2026, 7, 15, 16, 0)).toISOString(),
  );
  const hash = store.cwdHash("/ws/a");
  const key = `cwd-${hash}:j1`;
  const line = `0 */4 * * * ${RUNNER} ${key}  # pane-scheduler:${key}`;
  assert.ok(ct.text.includes(line), "tagged line in crontab");
  assert.ok(ct.text.includes("SHELL=/bin/bash"), "foreign line intact");
  assert.ok(existsSync(join(home, `${hash}.sqlite`)), "cwd store file");
  assert.ok(
    !existsSync(join(home, "global.sqlite")),
    "no global store touched",
  );
});

test("create (global scope) uses the global store and a bare key", async () => {
  const ct = fakeCrontab();
  const { home, core } = makeCore("/ws/a", ct);
  const v = await core.create({
    name: "daily",
    prompt: "p",
    cron: "30 1 * * *",
    scope: "global",
  });
  assert.equal(v.scope, "global");
  assert.equal(v.id, "j1");
  const line = `30 1 * * * ${RUNNER} j1  # pane-scheduler:j1`;
  assert.ok(ct.text.includes(line));
  assert.ok(existsSync(join(home, "global.sqlite")));
});

test("create refuses duplicate name per scope; nothing is written", async () => {
  const ct = fakeCrontab();
  const { home, core } = makeCore("/ws/b", ct);
  await core.create({ name: "nightly", prompt: "p", cron: "0 0 * * *" });
  const before = ct.text;
  await assert.rejects(
    () => core.create({ name: "nightly", prompt: "q", cron: "1 0 * * *" }),
    /already exists/,
  );
  assert.equal(ct.text, before, "crontab untouched");
  const db = new DatabaseSync(join(home, `${store.cwdHash("/ws/b")}.sqlite`));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 1);
  db.close();
});

test("duplicate name across scopes is fine (different stores)", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/c", ct);
  await core.create({ name: "shared", prompt: "p", cron: "0 0 * * *" });
  const v = await core.create({
    name: "shared",
    prompt: "p",
    cron: "1 0 * * *",
    scope: "global",
  });
  assert.equal(v.scope, "global");
});

test("create: job cwd is independent of the store key (global and cwd scopes)", async () => {
  // global scope: job cwd defaults to the session cwd, never empty
  const ct1 = fakeCrontab();
  const { core: c1 } = makeCore("/ws/sess", ct1);
  const g = await c1.create({ name: "gw", prompt: "p", cron: "0 0 * * *", scope: "global" });
  assert.equal(g.cwd, "/ws/sess", "global job runs in the creating session's cwd");

  // global scope with an explicit cwd: runs where told, still stored globally
  const g2 = await c1.create({
    name: "gw2",
    prompt: "p",
    cron: "1 0 * * *",
    scope: "global",
    cwd: "/shop/make-money",
  });
  assert.equal(g2.cwd, "/shop/make-money");

  // cwd scope with an explicit cwd: the job runs where told, but the store
  // is still keyed by the session cwd (list from this session must see it)
  const ct2 = fakeCrontab();
  const { home: h2, core: c2 } = makeCore("/ws/sess2", ct2);
  const j = await c2.create({ name: "w", prompt: "p", cron: "2 0 * * *", cwd: "/shop/elsewhere" });
  assert.equal(j.cwd, "/shop/elsewhere", "job runs where told");
  assert.ok(
    existsSync(join(h2, `${store.cwdHash("/ws/sess2")}.sqlite`)),
    "stored in the session's store, not the job's cwd",
  );
  const seen = (await c2.list()).map((x) => x.id);
  assert.ok(seen.includes(j.id), "visible to list from the creating session");
});

test("a removed job's name may be recreated; ids still mint forward", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/nm", ct);
  const a = await core.create({ name: "recycle", prompt: "p", cron: "0 11 * * *" });
  assert.equal(a.id, "j1");
  await core.remove("j1");
  const b = await core.create({ name: "recycle", prompt: "q", cron: "1 11 * * *" });
  assert.equal(b.name, "recycle", "same name after remove");
  assert.equal(b.id, "j2", "new id: the tombstone still counts");
});

test("create validates cron before writing anything", async () => {
  const ct = fakeCrontab();
  const before = ct.text;
  const { core } = makeCore("/ws/d", ct);
  await assert.rejects(
    () => core.create({ name: "bad", prompt: "p", cron: "* * * * " }),
    /cron:/,
  );
  assert.equal(ct.text, before);
});

test("create once: cron 'once' + at translates to cron fields; missing at refuses", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/e", ct);
  await assert.rejects(
    () => core.create({ name: "soon", prompt: "p", cron: "once" }),
    /at/,
  );
  const v = await core.create({
    name: "soon",
    prompt: "p",
    cron: "once",
    at: "2026-08-16T03:07:00Z", // TZ=UTC: local == UTC
  });
  assert.equal(v.cron, "7 3 16 8 *");
  assert.equal(v.at, "2026-08-16T03:07:00.000Z"); // normalized ISO
  const line = `7 3 16 8 * ${RUNNER} ${"cwd-" + store.cwdHash("/ws/e") + ":j1"}  # pane-scheduler:cwd-${store.cwdHash("/ws/e")}:j1`;
  assert.ok(ct.text.includes(line));
});

// ---- list + drift ----

test("list renders both scopes; clean jobs have null drift", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/f", ct);
  await core.create({ name: "cw", prompt: "p", cron: "0 0 * * *" });
  await core.create({
    name: "gl",
    prompt: "p",
    cron: "0 1 * * *",
    scope: "global",
  });
  const jobs = await core.list();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.scope).sort(), ["cwd", "global"]);
  assert.ok(jobs.every((j) => j.drift === null));
});

test("drift: missing line, altered cron, and state split are all flagged", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/g", ct);
  await core.create({
    name: "one",
    prompt: "p",
    cron: "0 0 * * *",
    scope: "global",
  });
  await core.create({ name: "two", prompt: "p", cron: "0 2 * * *" });

  // missing line
  ct.text = ct.text.replace(/.*pane-scheduler:j1.*\n?/, "");
  let jobs = await core.list();
  assert.match(jobs.find((j) => j.scope === "global").drift, /no crontab line/);
  assert.equal(jobs.find((j) => j.scope === "cwd").drift, null);

  // altered cron
  const hash = store.cwdHash("/ws/g");
  const key2 = `cwd-${hash}:j1`;
  ct.text = ct.text.replace(
    `0 2 * * * ${RUNNER} ${key2}`,
    `59 23 * * * ${RUNNER} ${key2}`,
  );
  jobs = await core.list();
  assert.match(jobs.find((j) => j.scope === "cwd").drift, /cron differs/);

  // state split: store says paused, line is active (pause kept the altered cron)
  await core.pause("j1", "cwd");
  ct.text = ct.text.replace(
    `# 59 23 * * * ${RUNNER} ${key2}`,
    `59 23 * * * ${RUNNER} ${key2}`,
  );
  jobs = await core.list();
  assert.match(jobs.find((j) => j.scope === "cwd").drift, /line is active/);
});

test("list marks a job running when its lock is held (probe seam)", async () => {
  const ct = fakeCrontab();
  const home = scratchDir();
  const core = createSchedulerCore(
    {
      home,
      sessionCwd: "/ws/h",
      session: "s",
      crontab: ct,
      now: () => NOW,
      runnerPath: RUNNER,
    },
    async (key) => key.endsWith(":j1") || key === "j1",
  );
  await core.create({ name: "locked", prompt: "p", cron: "0 0 * * *" });
  const jobs = await core.list();
  assert.equal(jobs[0].running, true);
});

// ---- pause / resume ----

test("pause comments the line, sets state, appends one event; resume restores the byte-identical line", async () => {
  const ct = fakeCrontab();
  const { home, core } = makeCore("/ws/i", ct);
  const v = await core.create({ name: "p", prompt: "p", cron: "0 3 * * *" });
  const activeLine = ct.text
    .trimEnd()
    .split("\n")
    .find((l) => l.includes("pane-scheduler:"));
  const paused = await core.pause(v.id);
  assert.equal(paused.state, "paused");
  assert.ok(
    ct.text.includes(`# ${activeLine}`),
    "line prefixed with '# ', tag intact",
  );
  const db = new DatabaseSync(join(home, `${store.cwdHash("/ws/i")}.sqlite`));
  const evs = db.prepare("SELECT op, session FROM events ORDER BY seq").all();
  assert.deepEqual(
    evs.map((e) => e.op),
    ["create", "pause"],
  );
  assert.equal(evs[1].session, "sess-core");
  db.close();

  const resumed = await core.resume(v.id);
  assert.equal(resumed.state, "active");
  assert.ok(ct.text.includes(activeLine));
  const jobs = await core.list();
  assert.equal(jobs[0].drift, null);
});

test("pause on paused refuses; resume on active refuses", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/j", ct);
  const v = await core.create({ name: "p", prompt: "p", cron: "0 4 * * *" });
  await assert.rejects(() => core.resume(v.id), /not paused/);
  await core.pause(v.id);
  await assert.rejects(() => core.pause(v.id), /already paused/);
  await core.resume(v.id);
  await assert.rejects(() => core.resume(v.id), /not paused/);
});

// ---- id resolution across scopes ----

test("id present in both scopes refuses without an explicit scope; with scope it works", async () => {
  const ct = fakeCrontab();
  const { core } = makeCore("/ws/k", ct);
  await core.create({
    name: "gl",
    prompt: "p",
    cron: "0 5 * * *",
    scope: "global",
  });
  await core.create({ name: "cw", prompt: "p", cron: "0 6 * * *" }); // both j1
  await assert.rejects(() => core.pause("j1"), /ambiguous/);
  await assert.rejects(() => core.pause("j1"), /scope/);
  const v = await core.pause("j1", "global");
  assert.equal(v.scope, "global");
  await assert.rejects(() => core.pause("j99"), /no job 'j99'/);
});

// ---- remove + runs ----

test("remove deletes the line and tombstones the row; runs survive the remove", async () => {
  const ct = fakeCrontab();
  const { home, core } = makeCore("/ws/l", ct);
  const v = await core.create({
    name: "doomed",
    prompt: "p",
    cron: "0 7 * * *",
  });
  // a couple of runs, appended like the runner does
  const path = join(home, `${store.cwdHash("/ws/l")}.sqlite`);
  const db = new DatabaseSync(path);
  store.appendEvent(
    db,
    "run",
    {
      id: v.id,
      status: "ok",
      exit: 0,
      durationMs: 1000,
      log: "runs/x/a.log",
      reason: null,
    },
    null,
  );
  db.close();

  const removed = await core.remove(v.id);
  assert.equal(removed.state, "removed");
  assert.ok(!ct.text.includes("pane-scheduler:"), "no trace in crontab");
  await assert.rejects(() => core.remove(v.id), /already removed/);

  const runs = await core.runs(v.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "ok");
  assert.equal(runs[0].id, v.id);
});

test("runs returns the last n in chronological order", async () => {
  const ct = fakeCrontab();
  const { home, core } = makeCore("/ws/m", ct);
  const v = await core.create({ name: "busy", prompt: "p", cron: "0 8 * * *" });
  const path = join(home, `${store.cwdHash("/ws/m")}.sqlite`);
  const db = new DatabaseSync(path);
  for (const [status, reason] of [
    ["ok", null],
    ["fail", "pi exit 1"],
    ["skip", "busy"],
  ]) {
    store.appendEvent(
      db,
      "run",
      {
        id: v.id,
        status,
        exit: status === "ok" ? 0 : status === "fail" ? 1 : null,
        durationMs: 10,
        log: `runs/x/${status}.log`,
        reason,
      },
      null,
    );
  }
  db.close();
  const all = await core.runs(v.id);
  assert.deepEqual(
    all.map((r) => r.status),
    ["ok", "fail", "skip"],
  );
  const two = await core.runs(v.id, undefined, 2);
  assert.deepEqual(
    two.map((r) => r.status),
    ["fail", "skip"],
  );
  await assert.rejects(() => core.runs("j404"), /no job 'j404'/);
});

// ---- crontab-first ordering: a crontab failure leaves no store row ----

test("crontab install failure refuses and leaves the store untouched", async () => {
  const text = "SHELL=/bin/bash\n";
  const ct = {
    list: async () => text,
    install: async () => {
      throw new Error("crontab install failed (exit 2): boom");
    },
  };
  const { home, core } = makeCore("/ws/n", ct);
  await assert.rejects(
    () => core.create({ name: "x", prompt: "p", cron: "0 9 * * *" }),
    /crontab install failed/,
  );
  const path = join(home, `${store.cwdHash("/ws/n")}.sqlite`);
  if (existsSync(path)) {
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 0);
    db.close();
  }
});

test("crontab list failure refuses loudly before anything is written", async () => {
  const ct = {
    list: async () => {
      throw new Error("crontab: binary not found");
    },
    install: async () => {},
  };
  const { home, core } = makeCore("/ws/o", ct);
  await assert.rejects(
    () => core.create({ name: "x", prompt: "p", cron: "0 10 * * *" }),
    /binary not found/,
  );
  // the read phase may create the empty store file; the invariant is zero events
  const path = join(home, `${store.cwdHash("/ws/o")}.sqlite`);
  if (existsSync(path)) {
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 0);
    db.close();
  }
});
