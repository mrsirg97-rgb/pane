import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXT_DIR, loadExtension, scratchDir } from "./_test-helpers.mjs";

const {
  SCHEMA,
  storePathFor,
  cwdHash,
  keyOf,
  parseKey,
  replayJobs,
  persistJobs,
  mintId,
  appendEvent,
  compactIfNeeded,
  COMPACT_THRESHOLD_EVENTS,
} = await loadExtension(join(EXT_DIR, "scheduler/store.ts"));

const home = scratchDir();
after(() => {});

function openStore(tag) {
  const db = new DatabaseSync(storePathFor(home, "cwd", `/t/${tag}`));
  db.exec(SCHEMA);
  return db;
}
const JOB = {
  name: "nightly",
  prompt: "do the thing",
  cron: "0 */4 * * *",
  at: null,
  cwd: "/ws/one",
  model: "qwen3.8-workers",
  busy: "skip",
};

// ---- paths and keys ----

test("storePathFor: global is fixed, cwd is hashed", () => {
  assert.equal(storePathFor(home, "global"), join(home, "global.sqlite"));
  const p = storePathFor(home, "cwd", "/ws/one");
  assert.match(p, /^\/.+\/[0-9a-f]{12}\.sqlite$/);
  assert.notEqual(storePathFor(home, "cwd", "/ws/two"), p);
  assert.equal(cwdHash("/ws/one").length, 12);
});

test("keyOf/parseKey round-trip, both scopes", () => {
  assert.equal(keyOf({ scope: "global", id: "j1" }), "j1");
  const key = keyOf({ scope: "cwd", hash: "abc123def456", id: "j2" });
  assert.equal(key, "cwd-abc123def456:j2");
  assert.deepEqual(parseKey("j1"), { scope: "global", hash: null, id: "j1" });
  assert.deepEqual(parseKey(key), {
    scope: "cwd",
    hash: "abc123def456",
    id: "j2",
  });
  assert.throws(() => parseKey("cwd-j1"), /key/);
  assert.throws(() => parseKey("cwd-xyz:j1"), /key/); // bad hash
  assert.throws(() => parseKey("jx"), /key/);
});

// ---- create + replay ----

test("create mints j1, j2 in order; one event per create; args as given", () => {
  const db = openStore("create");
  appendEvent(db, "create", JOB, "sess-a");
  appendEvent(db, "create", { ...JOB, name: "weekly" }, "sess-a");
  const map = replayJobs(db);
  assert.equal(map.size, 2);
  assert.deepEqual([...map.keys()].sort(), ["j1", "j2"]);
  assert.equal(map.get("j1").name, "nightly");
  assert.equal(map.get("j2").name, "weekly");
  assert.equal(map.get("j1").state, "active");
  const events = db
    .prepare("SELECT seq, op, args, session FROM events ORDER BY seq")
    .all();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].op, "create");
  assert.deepEqual(JSON.parse(events[0].args), JOB);
  assert.equal(events[0].session, "sess-a");
  db.close();
});

test("replay of a duplicate-name create is a defensive no-op", () => {
  const db = openStore("dup");
  appendEvent(db, "create", JOB, null);
  appendEvent(db, "create", { ...JOB, name: "nightly" }, null); // same name
  const map = replayJobs(db);
  assert.equal(map.size, 1); // first wins; ids never fork
  assert.deepEqual([...map.keys()], ["j1"]);
  db.close();
});

// ---- state machine ----

test("pause/resume/remove transitions, wrong order is a no-op", () => {
  const db = openStore("trans");
  appendEvent(db, "create", JOB, null);
  appendEvent(db, "pause", { id: "j1" }, "s");
  let map = replayJobs(db);
  assert.equal(map.get("j1").state, "paused");
  appendEvent(db, "pause", { id: "j1" }, "s"); // already paused: no-op
  map = replayJobs(db);
  assert.equal(map.get("j1").state, "paused");
  appendEvent(db, "resume", { id: "j1" }, "s");
  map = replayJobs(db);
  assert.equal(map.get("j1").state, "active");
  appendEvent(db, "remove", { id: "j1" }, "s");
  map = replayJobs(db);
  assert.equal(map.get("j1").state, "removed");
  appendEvent(db, "resume", { id: "j1" }, "s"); // removed: stays removed
  map = replayJobs(db);
  assert.equal(map.get("j1").state, "removed");
  db.close();
});

// ---- run events ----

test("run events update last_* on the job; latest wins; unknown id no-op", () => {
  const db = openStore("runs");
  appendEvent(db, "create", JOB, null);
  appendEvent(
    db,
    "run",
    {
      id: "j1",
      status: "ok",
      exit: 0,
      durationMs: 1200,
      log: "runs/global/j1/a.log",
      reason: null,
    },
    null,
  );
  let map = replayJobs(db);
  assert.equal(map.get("j1").lastStatus, "ok");
  assert.equal(map.get("j1").lastExit, 0);
  appendEvent(
    db,
    "run",
    {
      id: "j1",
      status: "fail",
      exit: 2,
      durationMs: 900,
      log: "runs/global/j1/b.log",
      reason: "pi exit 2",
    },
    null,
  );
  appendEvent(
    db,
    "run",
    {
      id: "j999",
      status: "skip",
      exit: null,
      durationMs: null,
      log: null,
      reason: "ghost",
    },
    null,
  );
  map = replayJobs(db);
  assert.equal(map.get("j1").lastStatus, "fail");
  assert.equal(map.get("j1").lastExit, 2);
  assert.equal(map.has("j999"), false);
  db.close();
});

// ---- id minting: never reused ----

test("ids are never reused, even after remove (tombstone counts)", () => {
  const db = openStore("mint");
  appendEvent(db, "create", JOB, null);
  appendEvent(db, "remove", { id: "j1" }, null);
  assert.equal(mintId(replayJobs(db)), "j2");
  appendEvent(db, "create", { ...JOB, name: "again" }, null);
  const map = replayJobs(db);
  assert.equal(map.get("j2").name, "again");
  assert.equal(mintId(map), "j3");
  db.close();
});

// ---- persistence + replay integrity ----

test("persist then wipe: replay from events alone restores the projection", () => {
  const db = openStore("wipe");
  appendEvent(db, "create", JOB, null);
  appendEvent(db, "pause", { id: "j1" }, "s");
  persistJobs(db, replayJobs(db));
  db.exec("DELETE FROM jobs");
  const map = replayJobs(db);
  assert.equal(map.size, 1);
  assert.equal(map.get("j1").state, "paused");
  assert.equal(map.get("j1").created_seq, 1);
  assert.equal(map.get("j1").updated_seq, 2);
  db.close();
});

// ---- compaction: bounded log, tombstones survive ----

test("compaction past the threshold: snapshot + mutation, state intact", () => {
  const db = openStore("compact");
  appendEvent(db, "create", JOB, null);
  appendEvent(db, "create", { ...JOB, name: "second" }, null);
  appendEvent(db, "remove", { id: "j2" }, null); // tombstone to survive
  // age the log with ghost run events (no-op on replay)
  for (let i = 0; i < COMPACT_THRESHOLD_EVENTS; i++)
    appendEvent(
      db,
      "run",
      {
        id: "jghost",
        status: "skip",
        exit: null,
        durationMs: null,
        log: null,
        reason: "pad",
      },
      null,
    );
  let map = replayJobs(db);
  assert.equal(compactIfNeeded(db, map, "s"), true);
  appendEvent(db, "pause", { id: "j1" }, "s");
  const events = db.prepare("SELECT seq, op FROM events ORDER BY seq").all();
  assert.equal(events.length, 2); // bounded: compact + the mutation
  assert.equal(events[0].op, "compact");
  assert.equal(events[1].op, "pause");
  map = replayJobs(db);
  assert.equal(map.size, 2); // j2 stays a tombstone
  assert.equal(map.get("j1").state, "paused");
  assert.equal(map.get("j2").state, "removed");
  assert.equal(mintId(map), "j3"); // id counter survived the snapshot
  db.close();
});

test("compaction under the threshold is a no-op", () => {
  const db = openStore("under");
  appendEvent(db, "create", JOB, null);
  const map = replayJobs(db);
  assert.equal(compactIfNeeded(db, map, "s"), false);
  db.close();
});

// ---- corruption ----

test("corrupt store file reads as empty (openDb delete policy, no crash)", async () => {
  const { openDb } = await loadExtension(join(EXT_DIR, "sqlite.ts"));
  const path = storePathFor(home, "cwd", "/ws/corrupt");
  writeFileSync(path, "not sqlite");
  const db = openDb({ path, schema: SCHEMA, policy: "delete" });
  try {
    assert.equal(replayJobs(db).size, 0);
  } finally {
    db.close();
  }
  // the disposed file is gone or replaced; a second open is clean
  const again = openDb({ path, schema: SCHEMA, policy: "delete" });
  try {
    assert.equal(replayJobs(again).size, 0);
  } finally {
    again.close();
  }
});

// ---- schema drift guard ----

test("schema drift guard: runner.mjs owns a byte-identical SCHEMA copy", async () => {
  // The deployed runner is standalone by design and cannot import store.ts;
  // it carries its own schema. Corruption-by-drift is the quiet kind, so pin
  // the two copies byte-for-byte.
  const runner = await loadExtension(join(EXT_DIR, "scheduler/runner.mjs"));
  assert.equal(runner.SCHEMA, SCHEMA);
});
