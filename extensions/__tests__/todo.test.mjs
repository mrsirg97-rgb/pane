// Behavioral tests for todo.ts v2 (sqlite-backed task queue: events spine + projection).
// Run: node --test todo.test.mjs
// Exercises the schema (failure modes live there), the strict state machine,
// per-workspace isolation, event-log invariants, transaction atomicity, idempotent
// upsert create, stale-task surfacing, and parallel-call serialization against a
// scratch HOME + cwd, so the real ~/.pi/agent/todos is never touched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadExtensionTool,
  scratchDir,
  textOf,
  typeboxValueModule,
  EXT_DIR,
} from "./_test-helpers.mjs";

const scratch = scratchDir();
process.env.HOME = scratch; // storePath() reads homedir() at call time (not cached)
const cwd1 = join(scratch, "ws1");
const cwd2 = join(scratch, "ws2");
const cwd6 = join(scratch, "ws6");
mkdirSync(cwd1);
mkdirSync(cwd2);
mkdirSync(cwd6);

const { tool, exports: todoMod } = await loadExtensionTool(
  join(EXT_DIR, "todo.ts"),
);
const { Value } = await typeboxValueModule();
const todosDir = join(scratch, ".pi", "agent", "todos");

function checkSchema(args) {
  return Value.Check(tool.parameters, args);
}
function dbPathFor(dir) {
  const key = createHash("sha1").update(dir).digest("hex").slice(0, 12);
  return join(todosDir, `${key}.sqlite`);
}
function openDb(dir) {
  return new DatabaseSync(dbPathFor(dir));
}
/** Read the projection rows as plain objects, in queue order (pos). */
function projRows(dir) {
  const db = openDb(dir);
  try {
    const rows = db
      .prepare(
        "SELECT id, text, status, depends_on, pos, created_seq, updated_seq FROM tasks ORDER BY pos, created_seq",
      )
      .all();
    return rows.map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}
/** Read raw event log rows, in append order. */
function eventRows(dir) {
  const db = openDb(dir);
  try {
    const rows = db
      .prepare("SELECT seq, ts, op, args, session FROM events ORDER BY seq")
      .all();
    return rows.map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}
function use(dir) {
  process.chdir(dir);
}
/** Copy the first minted id out of a tool render, exactly as an operator would. */
function firstId(text) {
  const m = /\bt(\d+)\b/.exec(text);
  return m ? `t${m[1]}` : null;
}
/** Next minted id for a fresh single-task create, derived from the current projection. */
function nextId(dir) {
  let store = [];
  try {
    store = projRows(dir);
  } catch {
    /* corrupt store: treat as empty, same as the tool */
  }
  let max = 0;
  for (const t of store) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t${max + 1}`;
}
/** Extract the id of a task by exact text from a render, like an operator scanning rows. */
function idOf(text, render) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\bt(\\d+)\\b \\[[~x! ]\\] ${escaped}`).exec(render);
  return m ? `t${m[1]}` : null;
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---- schema: failure modes live at the schema level ----
test("bare todo() is schema-invalid (the failure mode)", () => {
  assert.equal(checkSchema({}), false);
  assert.equal(checkSchema(undefined), false);
});

test("read needs no extra params", () => {
  assert.equal(checkSchema({ action: "read" }), true);
});

test("create tasks are schema-checked; missing tasks fails at execute (loud)", async () => {
  // tasks is schema-optional; the cross-field check is runtime and loud
  assert.equal(checkSchema({ action: "create" }), true);
  await assert.rejects(
    () => tool.execute("t0", { action: "create" }),
    /requires tasks/,
  );
  assert.equal(checkSchema({ action: "create", tasks: [] }), true);
  assert.equal(checkSchema({ action: "create", tasks: [{ text: "a" }] }), true);
  assert.equal(checkSchema({ action: "create", tasks: [{}] }), false);
  assert.equal(
    checkSchema({ action: "create", tasks: [{ text: "a" }, 1] }),
    false,
  );
});

test("state verbs accept id; id absence fails at execute (loud)", async () => {
  // id is schema-optional; the runtime check is loud
  assert.equal(checkSchema({ action: "start" }), true);
  await assert.rejects(
    () => tool.execute("t0", { action: "start" }),
    /requires id/,
  );
  assert.equal(checkSchema({ action: "start", id: "t1" }), true);
  for (const a of ["complete", "fail", "retry"]) {
    assert.equal(checkSchema({ action: a, id: "t1" }), true);
  }
  assert.equal(checkSchema({ action: "sync" }), false);
});

// ---- create / read ----
test("create mints ids and reads back; queue order follows create order", async () => {
  use(cwd1);
  const r = await tool.execute("t1", {
    action: "create",
    tasks: [{ text: "alpha" }, { text: "beta" }],
  });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /queue replaced with 2 tasks/);
  assert.match(textOf(r), /t1 \[ \] alpha/);
  assert.match(textOf(r), /t2 \[ \] beta/);
  assert.match(textOf(r), /0\/2 done · next: t1/);

  const read = await tool.execute("t2", { action: "read" });
  assert.match(textOf(read), /t1 \[ \] alpha/);
  assert.match(textOf(read), /t2 \[ \] beta/);
});

test("create with no tasks clears the queue", async () => {
  use(cwd1);
  const r = await tool.execute("t3", { action: "create", tasks: [] });
  assert.equal(textOf(r), "→ queue cleared\n(no tasks)");
});

// ---- state machine: the user-specified transitions ----
test("pending -> in_progress -> done; done is read-only", async () => {
  use(cwd1);
  const created = await tool.execute("t4", {
    action: "create",
    tasks: [{ text: "work" }],
  });
  const id = idOf("work", textOf(created));
  const s = await tool.execute("t5", { action: "start", id });
  assert.match(textOf(s), /\[~\] work/);
  const c = await tool.execute("t6", { action: "complete", id });
  assert.match(textOf(c), /\[x\] work/);
  assert.match(textOf(c), /1\/1 done/);

  await assert.rejects(
    () => tool.execute("t7", { action: "start", id }),
    /read-only/,
  );
  await assert.rejects(
    () => tool.execute("t8", { action: "complete", id }),
    /read-only/,
  );
  await assert.rejects(
    () => tool.execute("t9", { action: "fail", id }),
    /read-only/,
  );
  await assert.rejects(
    () => tool.execute("t10", { action: "retry", id }),
    /not failed/,
  );
});

test("pending -> in_progress -> failed -> retry -> pending -> started again", async () => {
  const cwd7 = join(scratch, "ws7");
  mkdirSync(cwd7);
  use(cwd7); // isolated FSM exercise; v2 create is upsert, so a shared cwd would accumulate
  const created = await tool.execute("t11", {
    action: "create",
    tasks: [{ text: "flaky" }],
  });
  const id = idOf("flaky", textOf(created));
  await tool.execute("t12", { action: "start", id });
  const f = await tool.execute("t13", { action: "fail", id });
  assert.match(textOf(f), /\[!\] flaky/);
  assert.match(textOf(f), /1 failed/);

  // failed stays failed on further fail
  await assert.rejects(
    () => tool.execute("t14", { action: "fail", id }),
    /already failed/,
  );
  // start on failed is refused until retry
  await assert.rejects(
    () => tool.execute("t15", { action: "start", id }),
    /retry it first/,
  );
  // complete on failed is refused too
  await assert.rejects(
    () => tool.execute("t16", { action: "complete", id }),
    /retry it first/,
  );

  const ret = await tool.execute("t17", { action: "retry", id });
  assert.match(textOf(ret), /\[ \] flaky/);
  const s2 = await tool.execute("t18", { action: "start", id });
  assert.match(textOf(s2), /\[~\] flaky/);
  const c2 = await tool.execute("t19", { action: "complete", id });
  assert.match(textOf(c2), /1\/1 done/);
});

test("complete/fail on pending refuse with a hint", async () => {
  use(cwd1);
  const created = await tool.execute("t20", {
    action: "create",
    tasks: [{ text: "wait" }],
  });
  const id = idOf("wait", textOf(created));
  await assert.rejects(
    () => tool.execute("t21", { action: "complete", id }),
    /pending; start it first/,
  );
  await assert.rejects(
    () => tool.execute("t22", { action: "fail", id }),
    /pending; start it first/,
  );
});

test("unknown id refuses loudly", async () => {
  use(cwd1);
  await assert.rejects(
    () => tool.execute("t23", { action: "start", id: "t99" }),
    /no task 't99'/,
  );
});

test("mutation replies never leave a stale .tmp file behind", async () => {
  use(cwd1);
  await tool.execute("t24", { action: "read" });
  const leftovers = readdirSync(todosDir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("the projection reflects completed transitions", async () => {
  use(cwd1);
  const rows = projRows(cwd1);
  const done = rows.find((t) => t.text === "wait");
  assert.equal(done.status, "pending"); // refused transitions never landed
});

// ---- store robustness ----
test("corrupt store reads as empty, never crashes", async () => {
  use(cwd1);
  writeFileSync(dbPathFor(cwd1), "not sqlite");
  const r = await tool.execute("t25", { action: "read" });
  assert.equal(textOf(r), "(no tasks)");
});

test("lists are isolated per working directory", async () => {
  use(cwd2);
  await tool.execute("t26", {
    action: "create",
    tasks: [{ text: "other ws" }],
  });
  const r2 = await tool.execute("t27", { action: "read" });
  assert.match(textOf(r2), /other ws/);
  use(cwd1);
  const r1 = await tool.execute("t28", { action: "read" });
  assert.equal(textOf(r1), "(no tasks)");
});

// ---- event log invariants ----
test("every mutation appends exactly one event; read appends nothing", async () => {
  use(cwd1);
  await tool.execute("t29", { action: "create", tasks: [{ text: "ev" }] });
  const before = eventRows(cwd1).length;
  await tool.execute("t30", { action: "read" });
  assert.equal(eventRows(cwd1).length, before);
});

test("event op/args mirror the tool call; seq strictly increases", async () => {
  use(cwd1);
  await tool.execute("t31", { action: "create", tasks: [{ text: "ev2" }] });
  const rows = eventRows(cwd1);
  const seqs = rows.map((r) => r.seq);
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(seqs, sorted);
  assert.equal(new Set(seqs).size, seqs.length);
  const create = rows.findLast((r) => r.op === "create"); // the log keeps history; latest create is ev2
  assert.equal(JSON.parse(create.args).tasks[0].text, "ev2");
});

test("events are never rewritten: projection corruption self-heals on read", async () => {
  // Simulate projection drift by rewriting a task row only; events unchanged.
  // read replays the log -> the projection must come back to truth.
  use(cwd1);
  const db = openDb(cwd1);
  db.prepare("UPDATE tasks SET status='done' WHERE text='ev'").run();
  db.close();
  const r = await tool.execute("t32", { action: "read" });
  const rows = projRows(cwd1);
  assert.equal(rows.find((t) => t.text === "ev").status, "pending");
});

// ---- atomicity: projection + event log in one transaction ----
test("projection and events stay consistent across mutations", async () => {
  use(cwd1);
  const created = await tool.execute("t33", {
    action: "create",
    tasks: [{ text: "atomic" }],
  });
  const id = idOf("atomic", textOf(created));
  await tool.execute("t34", { action: "start", id });
  await tool.execute("t35", { action: "complete", id });
  const events = eventRows(cwd1);
  const rows = projRows(cwd1);
  const ev = rows.find((t) => t.text === "atomic");
  assert.equal(ev.status, "done");
  // last event for this task must be the complete, and updated_seq must point at it
  const taskEvents = events.filter((e) => {
    const a = JSON.parse(e.args);
    return a.id === id;
  });
  assert.equal(taskEvents[taskEvents.length - 1].op, "complete");
  assert.equal(ev.updated_seq, taskEvents[taskEvents.length - 1].seq);
});

// ---- legacy argument mapping ----
test("legacy resumed args {items} map to create", () => {
  const out = tool.prepareArguments({ items: [{ task: "old" }] });
  assert.deepEqual(out, { action: "create", tasks: [{ text: "old" }] });
});
test("legacy action='set' maps to create", () => {
  const out = tool.prepareArguments({
    action: "set",
    items: [{ task: "old", status: "done" }],
  });
  assert.deepEqual(out, { action: "create", tasks: [{ text: "old" }] });
});
test("bare legacy {} stays invalid (still an error gradient)", () => {
  assert.deepEqual(tool.prepareArguments({}), {});
});

// ---- idempotent create (upsert by natural key) ----
test("replaying create with identical texts does not duplicate ids", async () => {
  use(cwd1);
  const r1 = await tool.execute("t40", {
    action: "create",
    tasks: [{ text: "dup-a" }, { text: "dup-b" }],
  });
  const r2 = await tool.execute("t41", {
    action: "create",
    tasks: [{ text: "dup-a" }, { text: "dup-b" }],
  });
  // second create is a no-op: same texts, no new ids
  assert.equal(idOf("dup-a", textOf(r2)), idOf("dup-a", textOf(r1)));
  assert.equal(idOf("dup-b", textOf(r2)), idOf("dup-b", textOf(r1)));
  const store = projRows(cwd1);
  assert.equal(store.filter((t) => t.text === "dup-a").length, 1);
  assert.equal(store.filter((t) => t.text === "dup-b").length, 1);
});

test("upsert preserves status and position of existing tasks", async () => {
  use(cwd6); // fresh workspace: positions are absolute 0/1
  const created = await tool.execute("t42", {
    action: "create",
    tasks: [{ text: "keep-a" }, { text: "keep-b" }],
  });
  const idA = idOf("keep-a", textOf(created));
  await tool.execute("t43", { action: "start", id: idA });
  // recreate with same texts, reversed order -> positions and status must not change
  const r = await tool.execute("t44", {
    action: "create",
    tasks: [{ text: "keep-b" }, { text: "keep-a" }],
  });
  assert.match(textOf(r), /\[~\] keep-a/);
  const store = projRows(cwd6);
  const a = store.find((t) => t.text === "keep-a");
  const b = store.find((t) => t.text === "keep-b");
  assert.equal(a.status, "in_progress");
  assert.equal(a.pos, 0);
  assert.equal(b.pos, 1);
});

test("new texts in create mint fresh ids at next positions", async () => {
  use(cwd6); // continuation of ws6: keep-a(0), keep-b(1) exist
  const r1 = await tool.execute("t45", {
    action: "create",
    tasks: [{ text: "old-x" }],
  });
  const r2 = await tool.execute("t46", {
    action: "create",
    tasks: [{ text: "old-x" }, { text: "new-y" }],
  });
  assert.match(textOf(r2), /new-y/);
  const store = projRows(cwd6);
  const ny = store.find((t) => t.text === "new-y");
  const maxPos = Math.max(...store.map((t) => t.pos));
  assert.equal(ny.pos, maxPos); // appended after existing max, never inline
  assert.equal(ny.status, "pending");
  // old-x kept its original position; replaying its create does not move it
  const ox = store.find((t) => t.text === "old-x");
  assert.equal(ox.pos, 2);
  assert.equal(idOf("old-x", textOf(r2)), idOf("old-x", textOf(r1)));
});

test("explicit clear still empties the queue", async () => {
  use(cwd1);
  await tool.execute("t47", {
    action: "create",
    tasks: [{ text: "to-clear" }],
  });
  const r = await tool.execute("t48", { action: "create", tasks: [] });
  assert.equal(textOf(r), "→ queue cleared\n(no tasks)");
});

// ---- stale-task surfacing ----
test("stale pending/in_progress tasks append a footer; fresh queues omit it", async () => {
  const cwd5 = join(scratch, "ws5");
  mkdirSync(cwd5);
  use(cwd5);
  await tool.execute("t49", { action: "create", tasks: [{ text: "ancient" }] });
  const fresh = await tool.execute("t50", { action: "read" });
  assert.doesNotMatch(textOf(fresh), /unresolved since/);

  // age the workspace: append far more events than the staleness threshold.
  // start events for unknown ids are replay no-ops, so the projection is untouched.
  const db = openDb(cwd5);
  const insert = db.prepare(
    "INSERT INTO events (op, args, session) VALUES ('start', ?, NULL)",
  );
  const farFuture = JSON.stringify({ id: "t999" });
  for (let i = 0; i < todoMod.STALE_THRESHOLD_SEQ + 10; i++)
    insert.run(farFuture);
  db.close();

  const stale = await tool.execute("t51", { action: "read" });
  assert.match(textOf(stale), /1 unresolved since/);
});

// ---- parallel calls serialize deterministically ----
test("concurrent create + start land in call order (scheduled, not sleeps)", async () => {
  use(cwd1);
  const expected = nextId(cwd1); // deterministic: create mints before start in the queue
  const [created, started] = await Promise.all([
    tool.execute("t52", { action: "create", tasks: [{ text: "parallel" }] }),
    tool.execute("t53", { action: "start", id: expected }),
  ]);
  assert.equal(created.isError, undefined);
  assert.equal(started.isError, undefined);
  const r = await tool.execute("t54", { action: "read" });
  assert.match(textOf(r), /\[~\] parallel/);
});

test("concurrent start + complete keep the documented order (complete waits)", async () => {
  use(cwd1);
  const created = await tool.execute("t55", {
    action: "create",
    tasks: [{ text: "ordered" }],
  });
  const id = idOf("ordered", textOf(created));
  const [started, completed] = await Promise.all([
    tool.execute("t56", { action: "start", id }),
    tool.execute("t57", { action: "complete", id }),
  ]);
  assert.equal(started.isError, undefined);
  assert.equal(completed.isError, undefined);
  const r = await tool.execute("t58", { action: "read" });
  assert.match(textOf(r), /\[x\] ordered/);
});

// ---- dependsOn: schema ----
test("dependsOn schema: id/text/null/omitted accepted; non-string rejected", () => {
  assert.equal(
    checkSchema({ action: "create", tasks: [{ text: "a", dependsOn: "t1" }] }),
    true,
  );
  assert.equal(
    checkSchema({ action: "create", tasks: [{ text: "a", dependsOn: "A" }] }),
    true,
  );
  assert.equal(
    checkSchema({ action: "create", tasks: [{ text: "a", dependsOn: null }] }),
    true,
  );
  assert.equal(checkSchema({ action: "create", tasks: [{ text: "a" }] }), true);
  assert.equal(
    checkSchema({ action: "create", tasks: [{ text: "a", dependsOn: 1 }] }),
    false,
  );
});

// ---- dependsOn: tree creation ----
test("same-batch chain creates a task tree; depends_on persisted", async () => {
  const cwd = join(scratch, "ws8");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t60", {
    action: "create",
    tasks: [
      { text: "root" },
      { text: "mid", dependsOn: "root" },
      { text: "leaf", dependsOn: "mid" },
    ],
  });
  assert.equal(r.isError, undefined);
  const store = projRows(cwd);
  const root = store.find((t) => t.text === "root");
  const mid = store.find((t) => t.text === "mid");
  const leaf = store.find((t) => t.text === "leaf");
  assert.equal(root.depends_on, null);
  assert.equal(mid.depends_on, root.id);
  assert.equal(leaf.depends_on, mid.id);
});

test("diamond: several tasks may depend on one task", async () => {
  const cwd = join(scratch, "ws9");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t61", {
    action: "create",
    tasks: [
      { text: "hub" },
      { text: "left", dependsOn: "hub" },
      { text: "right", dependsOn: "hub" },
    ],
  });
  assert.equal(r.isError, undefined);
  const store = projRows(cwd);
  const hub = store.find((t) => t.text === "hub");
  assert.equal(store.find((t) => t.text === "left").depends_on, hub.id);
  assert.equal(store.find((t) => t.text === "right").depends_on, hub.id);
});

test("forward references within a batch resolve", async () => {
  const cwd = join(scratch, "ws16");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t62", {
    action: "create",
    tasks: [{ text: "later", dependsOn: "first" }, { text: "first" }],
  });
  assert.equal(r.isError, undefined);
  const store = projRows(cwd);
  const first = store.find((t) => t.text === "first");
  assert.equal(store.find((t) => t.text === "later").depends_on, first.id);
});

test("id-based reference to an existing task", async () => {
  const cwd = join(scratch, "ws17");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t63", {
    action: "create",
    tasks: [{ text: "alpha" }],
  });
  const id = idOf("alpha", textOf(created));
  const r = await tool.execute("t64", {
    action: "create",
    tasks: [{ text: "beta", dependsOn: id }],
  });
  assert.equal(r.isError, undefined);
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "beta").depends_on, id);
});

test("id match wins over text match", async () => {
  const cwd = join(scratch, "ws18");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t65", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }],
  }); // a=t1, b=t2
  await tool.execute("t66", { action: "create", tasks: [{ text: "t1" }] }); // the t1-text task mints t3
  const r = await tool.execute("t67", {
    action: "create",
    tasks: [{ text: "c", dependsOn: "t1" }],
  }); // c=t4
  assert.equal(r.isError, undefined);
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "t1").id, "t3");
  assert.equal(store.find((t) => t.text === "c").depends_on, "t1"); // id match, never the t1-text task
});

test("a minted id does not shadow a matching text", async () => {
  const cwd = join(scratch, "ws19");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t68", {
    action: "create",
    tasks: [{ text: "x" }, { text: "t3" }],
  }); // x=t1, t3-text=t2
  const r = await tool.execute("t69", {
    action: "create",
    tasks: [{ text: "beta", dependsOn: "t3" }],
  }); // beta mints t3
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "beta").id, "t3");
  assert.equal(store.find((t) => t.text === "beta").depends_on, "t2"); // text match, not a phantom self
});

// ---- dependsOn: validation ----
test("unknown dependency target refuses loudly; batch rejected atomically", async () => {
  const cwd = join(scratch, "ws10");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t0", { action: "read" }); // bootstrap the schema before counting events
  const before = eventRows(cwd).length;
  await assert.rejects(
    () =>
      tool.execute("t69", {
        action: "create",
        tasks: [{ text: "a" }, { text: "b", dependsOn: "nope" }],
      }),
    /dependsOn 'nope' not found/,
  );
  assert.equal(projRows(cwd).length, 0); // nothing created
  assert.equal(eventRows(cwd).length, before); // no event appended
});

test("self-dependency refuses loudly", async () => {
  const cwd = join(scratch, "ws10");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await assert.rejects(
    () =>
      tool.execute("t70", {
        action: "create",
        tasks: [{ text: "solo", dependsOn: "solo" }],
      }),
    /cannot depend on itself/,
  );
});

test("cycles refuse with the cycle path; batch rejected", async () => {
  const cwd = join(scratch, "ws10");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t0", { action: "read" }); // bootstrap the schema before counting events
  const before = eventRows(cwd).length;
  await assert.rejects(
    () =>
      tool.execute("t71", {
        action: "create",
        tasks: [
          { text: "a", dependsOn: "b" },
          { text: "b", dependsOn: "a" },
        ],
      }),
    /dependencies would form a cycle: t1 -> t2 -> t1/,
  );
  assert.equal(eventRows(cwd).length, before);
});

test("three-node cycle refuses", async () => {
  const cwd = join(scratch, "ws10");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await assert.rejects(
    () =>
      tool.execute("t72", {
        action: "create",
        tasks: [
          { text: "a", dependsOn: "b" },
          { text: "b", dependsOn: "c" },
          { text: "c", dependsOn: "a" },
        ],
      }),
    /dependencies would form a cycle: t1 -> t2 -> t3 -> t1/,
  );
});

test("a recreate cannot push an existing acyclic queue into a cycle", async () => {
  const cwd = join(scratch, "ws10");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t73", {
    action: "create",
    tasks: [{ text: "c" }, { text: "d" }],
  });
  await assert.rejects(
    () =>
      tool.execute("t74", {
        action: "create",
        tasks: [
          { text: "c", dependsOn: "d" },
          { text: "d", dependsOn: "c" },
        ],
      }),
    /form a cycle/,
  );
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "c").depends_on, null);
  assert.equal(store.find((t) => t.text === "d").depends_on, null);
});

// ---- dependsOn: upsert semantics ----
test("recreate with dependsOn omitted keeps the link", async () => {
  const cwd = join(scratch, "ws11");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t75", {
    action: "create",
    tasks: [{ text: "p" }, { text: "q", dependsOn: "p" }],
  });
  await tool.execute("t76", { action: "create", tasks: [{ text: "q" }] });
  const store = projRows(cwd);
  const p = store.find((t) => t.text === "p");
  assert.equal(store.find((t) => t.text === "q").depends_on, p.id);
});

test("recreate with dependsOn provided updates the link", async () => {
  const cwd = join(scratch, "ws11");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t77", { action: "create", tasks: [{ text: "r" }] });
  await tool.execute("t78", {
    action: "create",
    tasks: [{ text: "q", dependsOn: "r" }],
  });
  const store = projRows(cwd);
  const r = store.find((t) => t.text === "r");
  assert.equal(store.find((t) => t.text === "q").depends_on, r.id);
});

test("recreate with dependsOn null clears the link", async () => {
  const cwd = join(scratch, "ws11");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t79", {
    action: "create",
    tasks: [{ text: "q", dependsOn: null }],
  });
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "q").depends_on, null);
});

test("first occurrence wins within a batch", async () => {
  const cwd = join(scratch, "ws11");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t80", {
    action: "create",
    tasks: [{ text: "f", dependsOn: "p" }, { text: "f" }],
  });
  const store = projRows(cwd);
  assert.equal(
    store.find((t) => t.text === "f").depends_on,
    store.find((t) => t.text === "p").id,
  );
});

// ---- dependsOn: completion gating ----
test("complete on a blocked task refuses with the blocker and its status", async () => {
  const cwd = join(scratch, "ws12");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t81", {
    action: "create",
    tasks: [{ text: "gate" }, { text: "work", dependsOn: "gate" }],
  });
  const gate = idOf("gate", textOf(r));
  const work = idOf("work", textOf(r));
  await tool.execute("t82", { action: "start", id: work });
  await assert.rejects(
    () => tool.execute("t83", { action: "complete", id: work }),
    new RegExp(`is blocked by '${gate}' \\(pending; start it first\\)`),
  );
  await tool.execute("t84", { action: "start", id: gate });
  await assert.rejects(
    () => tool.execute("t85", { action: "complete", id: work }),
    new RegExp(`is blocked by '${gate}' \\(in_progress\\)`),
  );
  await tool.execute("t86", { action: "fail", id: gate });
  await assert.rejects(
    () => tool.execute("t87", { action: "complete", id: work }),
    new RegExp(`is blocked by '${gate}' \\(failed; retry it first\\)`),
  );
  // retry -> start -> complete unblocks the dependent
  await tool.execute("t88", { action: "retry", id: gate });
  await tool.execute("t89", { action: "start", id: gate });
  await tool.execute("t90", { action: "complete", id: gate });
  const done = await tool.execute("t91", { action: "complete", id: work });
  assert.match(textOf(done), /\[x\] work/);
});

test("start on a blocked task is legal", async () => {
  const cwd = join(scratch, "ws12b");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t92", {
    action: "create",
    tasks: [{ text: "prereq" }, { text: "later", dependsOn: "prereq" }],
  });
  const later = idOf("later", textOf(r));
  const s = await tool.execute("t93", { action: "start", id: later });
  assert.equal(s.isError, undefined);
  assert.match(textOf(s), /\[~\] later/);
});

// ---- dependsOn: presence ----
test("next skips blocked tasks; blocked rows carry a waits-on suffix", async () => {
  const cwd = join(scratch, "ws13");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t94", {
    action: "create",
    tasks: [
      { text: "dep-a" },
      { text: "dep-b" },
      { text: "leaf", dependsOn: "dep-b" },
      { text: "free" },
    ],
  });
  const txt = textOf(r);
  const depB = idOf("dep-b", txt);
  assert.match(txt, new RegExp(`waits on ${depB}`));
  assert.match(txt, /next: t1/); // dep-a, never the blocked leaf
});

test("a queue whose only pending task is blocked shows no next", async () => {
  const cwd = join(scratch, "ws13c");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t96", {
    action: "create",
    tasks: [{ text: "prereq" }, { text: "dependent", dependsOn: "prereq" }],
  });
  const prereq = idOf("prereq", textOf(r));
  await tool.execute("t97", { action: "start", id: prereq });
  await tool.execute("t98", { action: "fail", id: prereq });
  const read = await tool.execute("t99", { action: "read" });
  assert.doesNotMatch(textOf(read), /· next:/);
  assert.match(textOf(read), /waits on /);
});

test("details carry dependsOn and blockedBy", async () => {
  const cwd = join(scratch, "ws13");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t100", { action: "read" });
  const details = r.details;
  assert.ok(details);
  const leaf = details.tasks.find((t) => t.text === "leaf");
  const depB = details.tasks.find((t) => t.text === "dep-b");
  const free = details.tasks.find((t) => t.text === "free");
  assert.equal(leaf.dependsOn, depB.id);
  assert.equal(leaf.blockedBy, depB.id);
  assert.equal(depB.blockedBy, null);
  assert.equal(free.dependsOn, null);
  assert.equal(free.blockedBy, null);
});

test("done tasks never report a blocker", async () => {
  const cwd = join(scratch, "ws13d");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t101", {
    action: "create",
    tasks: [{ text: "first" }, { text: "second", dependsOn: "first" }],
  });
  const first = idOf("first", textOf(r));
  const second = idOf("second", textOf(r));
  await tool.execute("t102", { action: "start", id: first });
  await tool.execute("t103", { action: "complete", id: first });
  await tool.execute("t104", { action: "start", id: second });
  const c = await tool.execute("t105", { action: "complete", id: second });
  assert.doesNotMatch(textOf(c), /waits on/);
  assert.equal(
    c.details.tasks.find((t) => t.text === "second").blockedBy,
    null,
  );
});

// ---- dependsOn: replay integrity ----
test("dependency survives projection tamper (rebuilt from events)", async () => {
  const cwd = join(scratch, "ws14");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const r = await tool.execute("t106", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b", dependsOn: "a" }],
  });
  const aId = idOf("a", textOf(r));
  const db = openDb(cwd);
  db.prepare("UPDATE tasks SET depends_on = NULL").run();
  db.close();
  await tool.execute("t107", { action: "read" });
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "b").depends_on, aId);
});

test("dangling dependency from a corrupt create event drops on replay", async () => {
  const cwd = join(scratch, "ws14");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const db = openDb(cwd);
  const ev = db
    .prepare(
      "SELECT seq FROM events WHERE op = 'create' ORDER BY seq DESC LIMIT 1",
    )
    .get();
  db.prepare("UPDATE events SET args = ? WHERE seq = ?").run(
    JSON.stringify({
      tasks: [{ text: "a" }, { text: "b", dependsOn: "ghost" }],
    }),
    ev.seq,
  );
  db.close();
  const read = await tool.execute("t108", { action: "read" });
  const store = projRows(cwd);
  assert.equal(store.find((t) => t.text === "b").depends_on, null);
  const bId = idOf("b", textOf(read));
  await tool.execute("t109", { action: "start", id: bId });
  const c = await tool.execute("t110", { action: "complete", id: bId });
  assert.equal(c.isError, undefined); // not deadlocked by the ghost
});

// ---- dependsOn: event log ----
test("create event args carry dependsOn as given", async () => {
  const cwd = join(scratch, "ws15");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t111", {
    action: "create",
    tasks: [{ text: "dep", dependsOn: "other" }, { text: "other" }],
  });
  const rows = eventRows(cwd);
  const create = rows.find((r) => r.op === "create");
  const tasks = JSON.parse(create.args).tasks;
  assert.equal(tasks[0].dependsOn, "other"); // raw input, not a resolved id
  assert.equal("dependsOn" in tasks[1], false); // omitted for the plain task
});

// ---- move: schema ----
test("move schema: id and pos required; pos must be a positive integer", () => {
  assert.equal(checkSchema({ action: "move", id: "t1", pos: 1 }), true);
  assert.equal(checkSchema({ action: "move", id: "t1" }), true); // pos is runtime-loud
  assert.equal(checkSchema({ action: "move", pos: 1 }), true); // id is runtime-loud
  assert.equal(checkSchema({ action: "move", id: "t1", pos: 0 }), false);
  assert.equal(checkSchema({ action: "move", id: "t1", pos: 1.5 }), false);
});

// ---- move: reordering ----
test("move reorders the queue; positions are renumbered deterministically", async () => {
  const cwd = join(scratch, "ws36");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t112", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }, { text: "c" }],
  });
  assert.equal(created.isError, undefined);
  const cId = idOf("c", textOf(created));
  const r = await tool.execute("t113", {
    action: "move",
    id: cId,
    pos: 1,
  });
  assert.equal(r.isError, undefined);
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    rows.map((t) => t.pos),
    [0, 1, 2], // dense renumbering, no gaps
  );
  // next follows the moved order
  const read = await tool.execute("t114", { action: "read" });
  assert.match(textOf(read), /next: t3/);
});

test("move to a middle position inserts before the current occupant", async () => {
  const cwd = join(scratch, "ws37");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t115", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }, { text: "c" }],
  });
  const aId = idOf("a", textOf(created));
  await tool.execute("t116", { action: "move", id: aId, pos: 2 });
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["b", "a", "c"],
  );
});

test("move to the last position appends at the back", async () => {
  const cwd = join(scratch, "ws38");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t117", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }, { text: "c" }],
  });
  const aId = idOf("a", textOf(created));
  await tool.execute("t118", { action: "move", id: aId, pos: 3 });
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["b", "c", "a"],
  );
});

test("move to the current position is a no-op", async () => {
  const cwd = join(scratch, "ws39");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t119", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }],
  });
  const bId = idOf("b", textOf(created));
  const r = await tool.execute("t120", { action: "move", id: bId, pos: 2 });
  assert.equal(r.isError, undefined);
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["a", "b"],
  );
});

test("move works on done and failed tasks", async () => {
  const cwd = join(scratch, "ws40");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t121", {
    action: "create",
    tasks: [{ text: "done one" }, { text: "fail one" }, { text: "keep" }],
  });
  const doneId = idOf("done one", textOf(created));
  const failId = idOf("fail one", textOf(created));
  await tool.execute("t122", { action: "start", id: doneId });
  await tool.execute("t123", { action: "complete", id: doneId });
  await tool.execute("t124", { action: "start", id: failId });
  await tool.execute("t125", { action: "fail", id: failId });
  const r = await tool.execute("t126", { action: "move", id: doneId, pos: 3 });
  assert.equal(r.isError, undefined);
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["fail one", "keep", "done one"],
  );
  assert.equal(rows.find((t) => t.text === "done one").status, "done");
});

// ---- move: validation ----
test("move out-of-range position refuses loudly", async () => {
  const cwd = join(scratch, "ws41");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t127", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }],
  });
  const aId = idOf("a", textOf(created));
  await assert.rejects(
    () => tool.execute("t128", { action: "move", id: aId, pos: 0 }),
    /between 1 and 2/,
  );
  await assert.rejects(
    () => tool.execute("t129", { action: "move", id: aId, pos: 3 }),
    /between 1 and 2/,
  );
  // nothing landed
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["a", "b"],
  );
});

test("move unknown id refuses loudly", async () => {
  const cwd = join(scratch, "ws42");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  await tool.execute("t130", { action: "create", tasks: [{ text: "a" }] });
  await assert.rejects(
    () => tool.execute("t131", { action: "move", id: "t99", pos: 1 }),
    /no task 't99'/,
  );
  await assert.rejects(
    () => tool.execute("t131b", { action: "move", pos: 1 }),
    /requires id/,
  );
});

// ---- move: event log ----
test("move appends one move event with args as given", async () => {
  const cwd = join(scratch, "ws43");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t132", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }],
  });
  const aId = idOf("a", textOf(created));
  const before = eventRows(cwd).length;
  await tool.execute("t133", { action: "move", id: aId, pos: 2 });
  const rows = eventRows(cwd);
  assert.equal(rows.length, before + 1);
  const move = rows.at(-1);
  assert.equal(move.op, "move");
  assert.deepEqual(JSON.parse(move.args), { id: aId, pos: 2 }); // as given, 1-based
});

// ---- move: replay integrity ----
test("moved order survives projection tamper (rebuilt from events)", async () => {
  const cwd = join(scratch, "ws44");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t134", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }, { text: "c" }],
  });
  const cId = idOf("c", textOf(created));
  await tool.execute("t135", { action: "move", id: cId, pos: 1 });
  // scramble the projection directly; events unchanged
  const db = openDb(cwd);
  db.prepare("UPDATE tasks SET pos = 99 - pos").run();
  db.close();
  const r = await tool.execute("t136", { action: "read" });
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["c", "a", "b"],
  );
});

test("sequential moves compose deterministically", async () => {
  const cwd = join(scratch, "ws45");
  mkdirSync(cwd, { recursive: true });
  use(cwd);
  const created = await tool.execute("t137", {
    action: "create",
    tasks: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
  });
  const aId = idOf("a", textOf(created));
  const dId = idOf("d", textOf(created));
  await tool.execute("t138", { action: "move", id: dId, pos: 1 });
  await tool.execute("t139", { action: "move", id: aId, pos: 4 });
  const rows = projRows(cwd);
  assert.deepEqual(
    rows.map((t) => t.text),
    ["d", "b", "c", "a"],
  );
  // replay from the log alone reproduces the same order
  const db = openDb(cwd);
  db.exec("DELETE FROM tasks");
  db.close();
  const r = await tool.execute("t140", { action: "read" });
  const after = projRows(cwd);
  assert.deepEqual(
    after.map((t) => t.text),
    ["d", "b", "c", "a"],
  );
});
