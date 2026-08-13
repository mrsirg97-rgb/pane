// Behavioral tests for todo.ts (task queue, single state file).
// Run: node --test todo.test.mjs
// Exercises the schema (failure modes live there), the strict state machine,
// per-workspace isolation, self-healing migration of the pre-id store shape,
// atomic-write hygiene, and parallel-call serialization against a scratch
// HOME + cwd, so the real ~/.pi/agent/todos is never touched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
mkdirSync(cwd1);
mkdirSync(cwd2);

const { tool } = await loadExtensionTool(join(EXT_DIR, "todo.ts"));
const { Value } = await typeboxValueModule();
const todosDir = join(scratch, ".pi", "agent", "todos");

function checkSchema(args) {
  return Value.Check(tool.parameters, args);
}
function storeFileFor(dir) {
  const key = createHash("sha1").update(dir).digest("hex").slice(0, 12);
  return join(todosDir, `${key}.json`);
}
function rawStore(dir) {
  const p = storeFileFor(dir);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function use(dir) {
  process.chdir(dir);
}
/** Copy the first minted id out of a tool render, exactly as an operator would. */
function firstId(text) {
  const m = /\bt(\d+)\b/.exec(text);
  return m ? `t${m[1]}` : null;
}
/** Next minted id for a fresh single-task create, derived from the current store. */
function nextId(dir) {
  let store = [];
  try {
    store = rawStore(dir) ?? [];
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
  await assert.rejects(() => tool.execute("t0", { action: "create" }), /requires tasks/);
  assert.equal(checkSchema({ action: "create", tasks: [] }), true);
  assert.equal(checkSchema({ action: "create", tasks: [{ text: "a" }] }), true);
  assert.equal(checkSchema({ action: "create", tasks: [{}] }), false);
  assert.equal(checkSchema({ action: "create", tasks: [{ text: "a" }, 1] }), false);
});

test("state verbs accept id; id absence fails at execute (loud)", async () => {
  // id is schema-optional; the runtime check is loud
  assert.equal(checkSchema({ action: "start" }), true);
  await assert.rejects(() => tool.execute("t0", { action: "start" }), /requires id/);
  assert.equal(checkSchema({ action: "start", id: "t1" }), true);
  for (const a of ["complete", "fail", "retry"]) {
    assert.equal(checkSchema({ action: a, id: "t1" }), true);
  }
  assert.equal(checkSchema({ action: "sync" }), false);
});

// ---- create / read ----
test("create replaces the queue and mints ids; read returns it", async () => {
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
  const created = await tool.execute("t4", { action: "create", tasks: [{ text: "work" }] });
  const id = firstId(textOf(created));
  const s = await tool.execute("t5", { action: "start", id });
  assert.match(textOf(s), /\[~\] work/);
  const c = await tool.execute("t6", { action: "complete", id });
  assert.match(textOf(c), /\[x\] work/);
  assert.match(textOf(c), /1\/1 done/);

  await assert.rejects(() => tool.execute("t7", { action: "start", id }), /read-only/);
  await assert.rejects(() => tool.execute("t8", { action: "complete", id }), /read-only/);
  await assert.rejects(() => tool.execute("t9", { action: "fail", id }), /read-only/);
  await assert.rejects(() => tool.execute("t10", { action: "retry", id }), /not failed/);
});

test("pending -> in_progress -> failed -> retry -> pending -> started again", async () => {
  use(cwd1);
  const created = await tool.execute("t11", { action: "create", tasks: [{ text: "flaky" }] });
  const id = firstId(textOf(created));
  await tool.execute("t12", { action: "start", id });
  const f = await tool.execute("t13", { action: "fail", id });
  assert.match(textOf(f), /\[!\] flaky/);
  assert.match(textOf(f), /1 failed/);

  // failed stays failed on further fail
  await assert.rejects(() => tool.execute("t14", { action: "fail", id }), /already failed/);
  // start on failed is refused until retry
  await assert.rejects(() => tool.execute("t15", { action: "start", id }), /retry it first/);
  // complete on failed is refused too
  await assert.rejects(() => tool.execute("t16", { action: "complete", id }), /retry it first/);

  const ret = await tool.execute("t17", { action: "retry", id });
  assert.match(textOf(ret), /\[ \] flaky/);
  const s2 = await tool.execute("t18", { action: "start", id });
  assert.match(textOf(s2), /\[~\] flaky/);
  const c2 = await tool.execute("t19", { action: "complete", id });
  assert.match(textOf(c2), /1\/1 done/);
});

test("complete/fail on pending refuse with a hint", async () => {
  use(cwd1);
  const created = await tool.execute("t20", { action: "create", tasks: [{ text: "wait" }] });
  const id = firstId(textOf(created));
  await assert.rejects(() => tool.execute("t21", { action: "complete", id }), /pending; start it first/);
  await assert.rejects(() => tool.execute("t22", { action: "fail", id }), /pending; start it first/);
});

test("unknown id refuses loudly", async () => {
  use(cwd1);
  await assert.rejects(() => tool.execute("t23", { action: "start", id: "t99" }), /no task 't99'/);
});

test("mutation replies never leave a stale .tmp file behind", async () => {
  use(cwd1);
  await tool.execute("t24", { action: "read" });
  const leftovers = readdirSync(todosDir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("the state file reflects completed transitions", async () => {
  use(cwd1);
  const store = rawStore(cwd1);
  const done = store.find((t) => t.text === "wait");
  assert.equal(done.status, "pending"); // refused transitions never landed
});

// ---- store robustness ----
test("corrupt store reads as empty, never crashes", async () => {
  use(cwd1);
  writeFileSync(storeFileFor(cwd1), "not json");
  const r = await tool.execute("t25", { action: "read" });
  assert.equal(textOf(r), "(no tasks)");
});

test("lists are isolated per working directory", async () => {
  use(cwd2);
  await tool.execute("t26", { action: "create", tasks: [{ text: "other ws" }] });
  const r2 = await tool.execute("t27", { action: "read" });
  assert.match(textOf(r2), /other ws/);
  use(cwd1);
  const r1 = await tool.execute("t28", { action: "read" });
  assert.equal(textOf(r1), "(no tasks)");
});

// ---- self-healing migration ----
test("pre-id {task,status} store self-heals to {id,text,status} once", async () => {
  const cwd3 = join(scratch, "ws3");
  mkdirSync(cwd3);
  writeFileSync(
    storeFileFor(cwd3),
    JSON.stringify([
      { task: "old done", status: "done" },
      { task: "old pending", status: "pending" },
    ]),
  );
  use(cwd3);
  const r = await tool.execute("t29", { action: "read" });
  assert.match(textOf(r), /\[x\] old done/);
  assert.match(textOf(r), /\[ \] old pending/);
  assert.match(textOf(r), /1\/2 done · next: t2/);

  // the file was rewritten with ids; the legacy shape is gone for good
  const store = rawStore(cwd3);
  assert.equal(store[0].id, "t1");
  assert.equal(store[1].id, "t2");
  assert.equal(store[0].text, "old done");
  assert.equal("task" in store[0], false);

  // idempotent: a second read does not rewrite or duplicate
  const before = readFileSync(storeFileFor(cwd3), "utf8");
  await tool.execute("t30", { action: "read" });
  assert.equal(readFileSync(storeFileFor(cwd3), "utf8"), before);
});

// ---- legacy argument mapping ----
test("legacy resumed args {items} map to create", () => {
  const out = tool.prepareArguments({ items: [{ task: "old" }] });
  assert.deepEqual(out, { action: "create", tasks: [{ text: "old" }] });
});
test("legacy action='set' maps to create", () => {
  const out = tool.prepareArguments({ action: "set", items: [{ task: "old", status: "done" }] });
  assert.deepEqual(out, { action: "create", tasks: [{ text: "old" }] });
});
test("bare legacy {} stays invalid (still an error gradient)", () => {
  assert.deepEqual(tool.prepareArguments({}), {});
});

// ---- parallel calls serialize deterministically ----
test("concurrent create + start land in call order (scheduled, not sleeps)", async () => {
  use(cwd1);
  const expected = nextId(cwd1); // deterministic: create mints before start in the queue
  const [created, started] = await Promise.all([
    tool.execute("t31", { action: "create", tasks: [{ text: "parallel" }] }),
    tool.execute("t32", { action: "start", id: expected }),
  ]);
  assert.equal(created.isError, undefined);
  assert.equal(started.isError, undefined);
  const r = await tool.execute("t33", { action: "read" });
  assert.match(textOf(r), /\[~\] parallel/);
});

test("concurrent start + complete keep the documented order (complete waits)", async () => {
  use(cwd1);
  const created = await tool.execute("t34", { action: "create", tasks: [{ text: "ordered" }] });
  const id = firstId(textOf(created));
  const [started, completed] = await Promise.all([
    tool.execute("t35", { action: "start", id }),
    tool.execute("t36", { action: "complete", id }),
  ]);
  assert.equal(started.isError, undefined);
  assert.equal(completed.isError, undefined);
  const r = await tool.execute("t37", { action: "read" });
  assert.match(textOf(r), /\[x\] ordered/);
});
