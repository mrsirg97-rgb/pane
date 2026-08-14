import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
mkdirSync(cwd1);
mkdirSync(cwd2);

const {
  tool,
  handlers,
  exports: remMod,
} = await loadExtensionTool(join(EXT_DIR, "rem.ts"));
const { Value } = await typeboxValueModule();
const remDir = join(scratch, ".pi", "agent", "rem");
const dbFile = join(remDir, "rem.sqlite");

function checkSchema(args) {
  return Value.Check(tool.parameters, args);
}
function use(dir) {
  process.chdir(dir);
}
function openDb() {
  return new DatabaseSync(dbFile);
}
function memRows() {
  const db = openDb();
  try {
    return db
      .prepare("SELECT * FROM memories ORDER BY id DESC")
      .all()
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}
function gramRows(id) {
  const db = openDb();
  try {
    return db
      .prepare("SELECT gram FROM trigrams WHERE memory_id = ? ORDER BY gram")
      .all(id)
      .map((r) => r.gram);
  } finally {
    db.close();
  }
}
function ftsRow(id) {
  const db = openDb();
  try {
    return db
      .prepare("SELECT rowid, content FROM memory_fts WHERE rowid = ?")
      .get(id);
  } finally {
    db.close();
  }
}
function metaValue(key) {
  const db = openDb();
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return r ? r.value : undefined;
  } finally {
    db.close();
  }
}
function idOf(content) {
  const rows = memRows();
  const hit = rows.find((r) => r.content === content);
  return hit ? hit.id : null;
}

test("bare rem() is schema-invalid (the failure mode)", () => {
  assert.equal(checkSchema({}), false);
  assert.equal(checkSchema(undefined), false);
});

test("learn content is schema-optional; missing fails at execute (loud)", async () => {
  assert.equal(checkSchema({ action: "learn" }), true);
  await assert.rejects(
    () => tool.execute("t0", { action: "learn" }),
    /requires content/,
  );
});

test("action enum refuses unknown verbs; shape errors refuse at check", () => {
  assert.equal(checkSchema({ action: "sync" }), false);
  assert.equal(checkSchema({ action: "learn", importance: 1.5 }), false);
  assert.equal(checkSchema({ action: "learn", importance: -0.1 }), false);
  assert.equal(checkSchema({ action: "recall", k: 0 }), false);
  assert.equal(checkSchema({ action: "recall", k: 51 }), false);
  assert.equal(checkSchema({ action: "recall", k: 1.5 }), false);
  assert.equal(checkSchema({ action: "prune" }), true);
  assert.equal(checkSchema({ action: "learn", scope: "all" }), true);
  assert.equal(checkSchema({ action: "learn", scope: "bogus" }), false);
  assert.equal(checkSchema({ action: "recall", scope: "all" }), true);
});

test("store opens empty on first open", () => {
  use(cwd1);
  assert.equal(memRows().length, 0);
});

test("corrupt store quarantines (renamed, never deleted) and reads empty", async () => {
  use(cwd1);
  writeFileSync(dbFile, "not sqlite");
  const r = await tool.execute("t1", { action: "recall" }); // no query = browse
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /no memories/);
  const leftovers = readdirSync(remDir).filter((f) => f.includes(".corrupt-"));
  assert.equal(leftovers.length, 1);
  assert.equal(memRows().length, 0); // fresh store is authoritative
});

test("learn stores content with scope, kind, importance; mints m1", async () => {
  use(cwd1);
  const r = await tool.execute("t2", {
    action: "learn",
    content: "the api returns 429 when the token expires",
    kind: "constraint",
    importance: 0.8,
  });
  assert.equal(r.isError, undefined);
  const d = r.details;
  assert.equal(d.action, "learn");
  assert.equal(d.memories.length, 1);
  const m = d.memories[0];
  assert.equal(m.id, 1);
  assert.equal(m.kind, "constraint");
  assert.equal(m.importance, 0.8);
  assert.equal(m.strength, 0.8);
  assert.equal(m.scope, remMod.shortHash(cwd1));
  assert.equal(m.scope_label, "ws1");
  assert.equal(m.access_count, 0);
  assert.equal(m.superseded_by, null);
  assert.match(textOf(r), /learned m1/);
  assert.equal(ftsRow(1).content, "the api returns 429 when the token expires");
  const grams = gramRows(1);
  assert.ok(grams.length > 0);
  assert.ok(grams.includes("api"));
});

test("learn is idempotent on (scope, content): same id, never duplicated", async () => {
  use(cwd1);
  const r1 = await tool.execute("t3", { action: "learn", content: "dup me" });
  const r2 = await tool.execute("t4", { action: "learn", content: "dup me" });
  assert.equal(r1.details.memories[0].id, r2.details.memories[0].id);
  assert.match(textOf(r2), /already known/);
  assert.equal(memRows().filter((r) => r.content === "dup me").length, 1);
});

test("re-learn accepts importance and supersedes updates on the existing row", async () => {
  use(cwd1);
  const r1 = await tool.execute("t5", { action: "learn", content: "upd me" });
  const id = r1.details.memories[0].id;
  const r2 = await tool.execute("t6", {
    action: "learn",
    content: "upd me",
    importance: 0.2,
  });
  assert.equal(r2.details.memories[0].id, id);
  assert.equal(memRows().find((r) => r.content === "upd me").importance, 0.2);
  assert.match(textOf(r2), /importance → 0.2/);
  const row = memRows().find((r) => r.content === "upd me");
  assert.equal(row.content, "upd me");
  assert.equal(row.strength, 0.5);
});

test("learn supersedes references an existing memory; missing target refuses loudly", async () => {
  use(cwd1);
  const r1 = await tool.execute("t7", { action: "learn", content: "old way" });
  const oldId = r1.details.memories[0].id;
  const r2 = await tool.execute("t8", {
    action: "learn",
    content: "new way",
    supersedes: oldId,
  });
  assert.equal(r2.details.memories[0].superseded_by, null); // the new one is not superseded
  assert.equal(
    memRows().find((r) => r.content === "old way").superseded_by,
    r2.details.memories[0].id,
  );
  await assert.rejects(
    () =>
      tool.execute("t9", {
        action: "learn",
        content: "another way",
        supersedes: 999,
      }),
    /supersedes target m999 not found/,
  );
});

test("learn scope=global stores in the global scope with label 'global'", async () => {
  use(cwd2);
  const r = await tool.execute("t10", {
    action: "learn",
    content: "global fact about agents",
    scope: "global",
  });
  const m = r.details.memories[0];
  assert.equal(m.scope, "global");
  assert.equal(m.scope_label, "global");
});

test("learn refuses scope=all at execute (loud)", async () => {
  use(cwd1);
  await assert.rejects(
    () => tool.execute("t11", { action: "learn", content: "x", scope: "all" }),
    /scope must be project or global/,
  );
});

test("per-project memories are isolated by cwd scope", async () => {
  use(cwd1);
  const r1 = await tool.execute("t12", {
    action: "learn",
    content: "only ws1",
  });
  const m1 = r1.details.memories[0];
  use(cwd2);
  const r2 = await tool.execute("t13", {
    action: "learn",
    content: "only ws1",
  });
  const m2 = r2.details.memories[0];
  assert.notEqual(m1.id, m2.id); // distinct scope, distinct memory
  assert.equal(m1.scope_label, "ws1");
  assert.equal(m2.scope_label, "ws2");
});

test("re-learn with supersedes including its own id is a no-op (no self-demotion)", async () => {
  use(cwd1);
  const r1 = await tool.execute("t14", {
    action: "learn",
    content: "self ref",
  });
  const id = r1.details.memories[0].id;
  const r2 = await tool.execute("t15", {
    action: "learn",
    content: "self ref",
    supersedes: id,
  });
  const row = memRows().find((r) => r.content === "self ref");
  assert.equal(row.superseded_by, null);
  assert.match(textOf(r2), /already known/);
});

test("recall by prose intent finds the memory (both arms reach)", async () => {
  use(cwd1);
  await tool.execute("t20", {
    action: "learn",
    content: "the api returns 429 when the token expires",
  });
  const r = await tool.execute("t21", {
    action: "recall",
    query: "token expires",
  });
  assert.equal(r.isError, undefined);
  const hits = r.details.hits;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].content, "the api returns 429 when the token expires");
  assert.equal(hits[0].match, "both");
});

test("reserved FTS operators do not break the query grammar", async () => {
  use(cwd1);
  await tool.execute("t21", { action: "learn", content: "to be or not to be" });
  const r = await tool.execute("t22", { action: "recall", query: "be or not" });
  assert.equal(r.isError, undefined);
  assert.ok(r.details.hits.some((h) => h.content === "to be or not to be"));
});

test("no match renders '(no memories)', never an error", async () => {
  use(cwd1);
  const r = await tool.execute("t23", { action: "recall", query: "zzzznope" });
  assert.equal(r.isError, undefined);
  assert.equal(r.details.hits.length, 0);
  assert.match(textOf(r), /\(no memories\)/);
});

test("identifier corpus: llamaswap finds llama-swap on :8090 (fuzzy)", async () => {
  use(cwd1);
  await tool.execute("t24", {
    action: "learn",
    content: "llama-swap on :8090 OOMs at depth",
    kind: "solution",
  });
  const r = await tool.execute("t25", { action: "recall", query: "llamaswap" });
  const hit = r.details.hits.find((h) => h.content.includes("llama-swap"));
  assert.ok(hit, "llamaswap must reach the llama-swap memory");
  assert.equal(hit.match, "fuzzy");
});

test("identifier corpus: UD IQ1S finds UD-IQ1_S (both arms)", async () => {
  use(cwd1);
  await tool.execute("t26", {
    action: "learn",
    content: "UD-IQ1_S quant of DeepSeek-V4-Flash",
  });
  const r = await tool.execute("t27", { action: "recall", query: "UD IQ1S" });
  const hit = r.details.hits.find((h) => h.content.includes("UD-IQ1_S"));
  assert.ok(hit, "UD IQ1S must reach the UD-IQ1_S memory");
  assert.equal(hit.match, "both");
});

test("identifier corpus: n-cpu-moe finds the flag memory (both arms)", async () => {
  use(cwd1);
  await tool.execute("t28", {
    action: "learn",
    content: "--n-cpu-moe 19 OOMs at depth",
  });
  const r = await tool.execute("t29", { action: "recall", query: "n-cpu-moe" });
  const hit = r.details.hits.find((h) => h.content.includes("n-cpu-moe"));
  assert.ok(hit, "n-cpu-moe must reach the flag memory");
  assert.equal(hit.match, "both");
});

test("fts-less build disables only the semantic arm; fuzzy fallback still serves", async () => {
  use(cwd1);
  remMod.__setFtsAvailable(false);
  try {
    const r = await tool.execute("t30", { action: "recall", query: "UD IQ1S" });
    const hit = r.details.hits.find((h) => h.content.includes("UD-IQ1_S"));
    assert.ok(hit);
    assert.equal(hit.match, "fuzzy");
    const lr = await tool.execute("t30a", {
      action: "learn",
      content: "ftsless newcomer",
    });
    assert.equal(lr.isError, undefined);
    const rr = await tool.execute("t30b", {
      action: "recall",
      query: "ftsless",
    });
    assert.ok(rr.details.hits.some((h) => h.content === "ftsless newcomer"));
  } finally {
    remMod.__setFtsAvailable(undefined);
  }
});

test("stemming path: 'run fast' reaches an inflected memory", async () => {
  use(cwd1);
  await tool.execute("t31", { action: "learn", content: "running fast" });
  const r = await tool.execute("t32", { action: "recall", query: "run fast" });
  assert.ok(r.details.hits.some((h) => h.content === "running fast"));
});

test("recall k caps live hits", async () => {
  use(cwd1);
  for (let i = 1; i <= 5; i++) {
    await tool.execute(`t3${i}`, { action: "learn", content: `pattern ${i}` });
  }
  const r = await tool.execute("t36", {
    action: "recall",
    query: "pattern",
    k: 2,
  });
  assert.equal(r.details.hits.length, 2);
});

test("effective strength: an aged memory loses to a fresh one, stored strength untouched", async () => {
  use(cwd1);
  await tool.execute("t37", {
    action: "learn",
    content: "aged fix for widget",
  });
  const aged = memRows().find((r) => r.content === "aged fix for widget");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const db = openDb();
  db.prepare("UPDATE memories SET last_consolidated_at = ? WHERE id = ?").run(
    old,
    aged.id,
  );
  db.close();
  await tool.execute("t38", {
    action: "learn",
    content: "fresh fix for widget",
  });
  const r = await tool.execute("t39", {
    action: "recall",
    query: "widget fix",
  });
  const fresh = r.details.hits.find(
    (h) => h.content === "fresh fix for widget",
  );
  const agedHit = r.details.hits.find(
    (h) => h.content === "aged fix for widget",
  );
  assert.ok(fresh && agedHit);
  assert.ok(fresh.effective_strength > agedHit.effective_strength);
  assert.ok(
    agedHit.effective_strength < 0.3,
    "decay must be observable without consolidate",
  );
  const row = memRows().find((r) => r.content === "aged fix for widget");
  assert.equal(row.strength, 0.5);
  assert.equal(row.access_count, 1);
  assert.ok(row.last_accessed_at != null);
});

test("superseded memories drop by default; include_superseded fills the unused budget", async () => {
  use(cwd1);
  const a = await tool.execute("t40", {
    action: "learn",
    content: "old approach to widgets",
  });
  const oldId = a.details.memories[0].id;
  await tool.execute("t41", {
    action: "learn",
    content: "new approach to widgets",
    supersedes: oldId,
  });
  const r1 = await tool.execute("t42", {
    action: "recall",
    query: "widgets approach",
  });
  assert.equal(r1.details.hits.length, 1);
  assert.equal(r1.details.hits[0].content, "new approach to widgets");
  const r2 = await tool.execute("t43", {
    action: "recall",
    query: "widgets approach",
    include_superseded: true,
  });
  assert.equal(r2.details.hits.length, 2);
  const old = r2.details.hits.find(
    (h) => h.content === "old approach to widgets",
  );
  assert.equal(
    old.superseded_by,
    r2.details.hits.find((h) => h.content === "new approach to widgets").id,
  );
});

test("hybrid scope: project hits first, global fills only the unused budget", async () => {
  use(cwd2);
  await tool.execute("t44", {
    action: "learn",
    content: "global widget lore",
    scope: "global",
  });
  await tool.execute("t45", {
    action: "learn",
    content: "global widget warning",
    scope: "global",
  });
  use(cwd1);
  const thin = await tool.execute("t46", { action: "recall", query: "widget" });
  const labels = thin.details.hits.map((h) => h.scope_label);
  assert.equal(labels[0], "ws1");
  assert.ok(labels.includes("global"));
  const full = await tool.execute("t47", {
    action: "recall",
    query: "widget",
    k: 1,
  });
  assert.equal(full.details.hits.length, 1);
  assert.equal(full.details.hits[0].scope_label, "ws1");
});

test("scope=all interleaves scopes; scope=global excludes project", async () => {
  use(cwd1);
  const all = await tool.execute("t48", {
    action: "recall",
    query: "widget",
    scope: "all",
  });
  const labels = all.details.hits.map((h) => h.scope_label);
  assert.ok(labels.includes("ws1") && labels.includes("global"));
  const g = await tool.execute("t49", {
    action: "recall",
    query: "widget",
    scope: "global",
  });
  assert.ok(g.details.hits.length > 0);
  assert.ok(g.details.hits.every((h) => h.scope_label === "global"));
});

test("kind filter narrows recall", async () => {
  use(cwd1);
  await tool.execute("t50", {
    action: "learn",
    content: "widget is blue",
    kind: "constraint",
  });
  const r = await tool.execute("t51", {
    action: "recall",
    query: "widget",
    kind: "solution",
  });
  assert.ok(r.details.hits.every((h) => h.kind === "solution"));
});

test("empty query browses latest by effective strength", async () => {
  use(cwd1);
  const r = await tool.execute("t52", { action: "recall" });
  assert.equal(r.isError, undefined);
  assert.ok(r.details.hits.length > 0);
  assert.ok(r.details.hits.every((h) => h.match === "browse"));
  const strengths = r.details.hits.map((h) => h.effective_strength);
  const sorted = [...strengths].sort((a, b) => b - a);
  assert.deepEqual(strengths, sorted);
});

test("reflect stores a distilled memory with source; kind defaults to reflection", async () => {
  use(cwd1);
  const r = await tool.execute("t60", {
    action: "reflect",
    content: "the write path never leaves a stale tmp file",
    source: "log: debugged 4 hours over the todo store",
  });
  assert.equal(r.isError, undefined);
  const m = r.details.memories[0];
  assert.equal(m.kind, "reflection");
  assert.equal(m.importance, 0.3);
  assert.equal(m.source, "log: debugged 4 hours over the todo store");
  assert.match(textOf(r), /reflected m\d+/);
});

test("reflect memory is schema-optional; missing fails at execute (loud)", async () => {
  use(cwd1);
  assert.equal(checkSchema({ action: "reflect" }), true);
  await assert.rejects(
    () => tool.execute("t61", { action: "reflect" }),
    /requires content/,
  );
});

test("reflect accepts explicit importance and is idempotent on memory", async () => {
  use(cwd1);
  const r1 = await tool.execute("t62", {
    action: "reflect",
    content: "repeatable reflection",
    importance: 0.7,
  });
  const r2 = await tool.execute("t63", {
    action: "reflect",
    content: "repeatable reflection",
    importance: 0.7,
  });
  assert.equal(r1.details.memories[0].id, r2.details.memories[0].id);
  assert.equal(
    memRows().filter((r) => r.content === "repeatable reflection").length,
    1,
  );
  assert.match(textOf(r2), /already known/);
});

test("session_compact hook stores a deduped reflection scoped to ctx.cwd", async () => {
  use(cwd1);
  const summary = "compacted session: fixed the todo render path and its tests";
  const ev = { compactionEntry: { summary } };
  await handlers.session_compact(ev, { cwd: cwd1 });
  await handlers.session_compact(ev, { cwd: cwd1 }); // replay: dedup
  const rows = memRows().filter((r) => r.content === summary);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "reflection");
  assert.equal(rows[0].importance, 0.2);
  assert.equal(rows[0].scope, remMod.shortHash(cwd1));
  assert.ok(rows[0].source.includes("compaction"));
});

test("session_compact hook is fire-and-forget: bad events never crash", async () => {
  use(cwd2);
  const before = memRows().length;
  await handlers.session_compact(undefined, { cwd: cwd2 });
  await handlers.session_compact({ compactionEntry: {} }, { cwd: cwd2 });
  await handlers.session_compact(
    { compactionEntry: { summary: "  " } },
    { cwd: cwd2 },
  );
  assert.equal(memRows().length, before);
});

test("prune verb is schema-optional; missing fails at execute (loud)", async () => {
  use(cwd1);
  assert.equal(checkSchema({ action: "prune" }), true);
  await assert.rejects(
    () => tool.execute("t70", { action: "prune" }),
    /prune requires verb remove\|reduce\|consolidate/,
  );
});

test("prune consolidate is idempotent: decays aged strength, resets the window", async () => {
  use(cwd1);
  await tool.execute("t71", { action: "learn", content: "consolidate me" });
  const row = memRows().find((r) => r.content === "consolidate me");
  const db = openDb();
  db.prepare("UPDATE memories SET last_consolidated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 40 * 86400000).toISOString(),
    row.id,
  );
  db.close();
  const r1 = await tool.execute("t72", {
    action: "prune",
    verb: "consolidate",
  });
  const after = memRows().find((r) => r.content === "consolidate me");
  assert.ok(after.strength < 0.3, "decay must be persisted by consolidate");
  assert.equal(after.access_count, 0, "checkpoint window resets");
  const r2 = await tool.execute("t73", {
    action: "prune",
    verb: "consolidate",
  });
  const twice = memRows().find((r) => r.content === "consolidate me");
  assert.ok(
    Math.abs(twice.strength - after.strength) < 1e-6,
    "replay with no elapsed time is a no-op",
  );
});

test("consolidate reinforces accessed memories and no-ops on fresh ones", async () => {
  use(cwd1);
  await tool.execute("t74", { action: "learn", content: "fresh target" });
  const fresh = memRows().find((r) => r.content === "fresh target");
  await tool.execute("t75", { action: "recall", query: "fresh" });
  await tool.execute("t76", { action: "prune", verb: "consolidate" });
  const after = memRows().find((r) => r.content === "fresh target");
  assert.ok(
    after.strength > 0.5 && after.strength <= 0.6,
    "reinforcement must apply",
  );
});

test("prune remove by ids deletes memory + fts row (rowid) + trigrams, no orphans", async () => {
  use(cwd1);
  await tool.execute("t77", { action: "learn", content: "doomed memory" });
  const doomed = memRows().find((r) => r.content === "doomed memory");
  const r = await tool.execute("t78", {
    action: "prune",
    verb: "remove",
    ids: [doomed.id],
  });
  assert.match(textOf(r), /removed 1/);
  assert.equal(
    memRows().find((r) => r.content === "doomed memory"),
    undefined,
  );
  assert.equal(ftsRow(doomed.id), undefined, "no orphaned fts row");
  assert.equal(gramRows(doomed.id).length, 0, "no orphaned trigram rows");
});

test("prune remove by criteria: older_than_days and kind and scope", async () => {
  use(cwd1);
  await tool.execute("t79", {
    action: "learn",
    content: "old constraint",
    kind: "constraint",
  });
  const old = memRows().find((r) => r.content === "old constraint");
  const db = openDb();
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
    new Date(Date.now() - 10 * 86400000).toISOString(),
    old.id,
  );
  db.close();
  const r1 = await tool.execute("t80", {
    action: "prune",
    verb: "remove",
    kind: "constraint",
  });
  assert.match(textOf(r1), /removed \d+/);
  assert.equal(
    memRows().find((r) => r.content === "old constraint"),
    undefined,
  );
  assert.ok(
    memRows().some((r) => r.kind !== "constraint"),
    "other kinds survive",
  );
  await tool.execute("t81", { action: "learn", content: "young victim" });
  const young = memRows().find((r) => r.content === "young victim");
  const r2 = await tool.execute("t82", {
    action: "prune",
    verb: "remove",
    older_than_days: 5,
  });
  assert.match(textOf(r2), /removed 0/);
  assert.ok(memRows().find((r) => r.content === "young victim"));
});

test("prune remove counts actual deletions; missing ids report zero", async () => {
  use(cwd1);
  const r = await tool.execute("t83a", {
    action: "prune",
    verb: "remove",
    ids: [999999],
  });
  assert.match(textOf(r), /removed 0/);
});

test("prune consolidate honors a selection; no selection means the whole store", async () => {
  use(cwd1);
  await tool.execute("t83b", { action: "learn", content: "narrow victim" });
  const victim = memRows().find((r) => r.content === "narrow victim");
  const db = openDb();
  db.prepare("UPDATE memories SET last_consolidated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 40 * 86400000).toISOString(),
    victim.id,
  );
  db.close();
  await tool.execute("t83c", { action: "learn", content: "narrow bystander" });
  const bystander = memRows().find((r) => r.content === "narrow bystander");
  const before = bystander.last_consolidated_at;
  const r = await tool.execute("t83d", {
    action: "prune",
    verb: "consolidate",
    ids: [victim.id],
  });
  assert.match(textOf(r), /consolidated 1/);
  const after = memRows().find((r) => r.content === "narrow victim");
  assert.ok(after.strength < 0.3, "selected memory decays");
  const kept = memRows().find((r) => r.content === "narrow bystander");
  assert.equal(kept.strength, 0.5, "unselected memory untouched");
  assert.equal(
    kept.last_consolidated_at,
    before,
    "checkpoint window untouched",
  );
});

test("prune remove on a genuinely fts-less store never touches memory_fts", async () => {
  use(cwd1);
  const db = openDb();
  db.exec("DROP TABLE IF EXISTS memory_fts");
  db.close();
  remMod.__setFtsAvailable(false);
  try {
    await tool.execute("t83e", { action: "learn", content: "ftsless victim" });
    const v = memRows().find((r) => r.content === "ftsless victim");
    const r = await tool.execute("t83f", {
      action: "prune",
      verb: "remove",
      ids: [v.id],
    });
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /removed 1/);
    assert.equal(
      memRows().find((r) => r.content === "ftsless victim"),
      undefined,
    );
    assert.equal(gramRows(v.id).length, 0, "trigrams still cleaned");
  } finally {
    remMod.__setFtsAvailable(undefined);
  }
});

test("prune remove/reduce with no selection refuse loudly", async () => {
  use(cwd1);
  await assert.rejects(
    () => tool.execute("t83", { action: "prune", verb: "remove" }),
    /needs ids or criteria/,
  );
  await assert.rejects(
    () => tool.execute("t84", { action: "prune", verb: "reduce" }),
    /needs ids or criteria/,
  );
});

test("prune reduce lowers importance; missing target importance refuses loudly", async () => {
  use(cwd1);
  await tool.execute("t85", {
    action: "learn",
    content: "reducable",
    importance: 0.9,
  });
  const target = memRows().find((r) => r.content === "reducable");
  await assert.rejects(
    () =>
      tool.execute("t86", {
        action: "prune",
        verb: "reduce",
        ids: [target.id],
      }),
    /reduce needs an importance/,
  );
  const r = await tool.execute("t87", {
    action: "prune",
    verb: "reduce",
    ids: [target.id],
    importance: 0.2,
  });
  assert.match(textOf(r), /reduced 1 to 0.2/);
  assert.equal(
    memRows().find((r) => r.content === "reducable").importance,
    0.2,
  );
});

test("removing the superseding memory unsupersedes the older (SET NULL)", async () => {
  use(cwd1);
  const a = await tool.execute("t88", {
    action: "learn",
    content: "superseded legacy",
  });
  const oldId = a.details.memories[0].id;
  const b = await tool.execute("t89", {
    action: "learn",
    content: "superseding new",
    supersedes: oldId,
  });
  const newId = b.details.memories[0].id;
  await tool.execute("t90", { action: "prune", verb: "remove", ids: [newId] });
  const legacy = memRows().find((r) => r.content === "superseded legacy");
  assert.equal(legacy.superseded_by, null);
  const r = await tool.execute("t91", { action: "recall", query: "legacy" });
  assert.ok(
    r.details.hits.some((h) => h.content === "superseded legacy"),
    "legacy resurfaces",
  );
});

test("AUTOINCREMENT: pruned ids are never reused by later learns", async () => {
  use(cwd1);
  const r1 = await tool.execute("t92", {
    action: "learn",
    content: "highest id victim",
  });
  const victim = r1.details.memories[0].id;
  await tool.execute("t93", { action: "prune", verb: "remove", ids: [victim] });
  const r2 = await tool.execute("t94", {
    action: "learn",
    content: "id reuse probe",
  });
  const next = r2.details.memories[0].id;
  assert.ok(next > victim, "rowid reuse would re-point superseded_by");
});

test("prune remove by ids ignores scope: the ids are the selection", async () => {
  use(cwd2);
  await tool.execute("t95", {
    action: "learn",
    content: "global doomed",
    scope: "global",
  });
  const g = memRows().find((r) => r.content === "global doomed");
  use(cwd1);
  const local = await tool.execute("t96", {
    action: "prune",
    verb: "remove",
    ids: [g.id],
  });
  assert.match(textOf(local), /removed 1/);
  assert.equal(
    memRows().find((r) => r.content === "global doomed"),
    undefined,
  );
});

test("concurrent calls serialize deterministically in call order", async () => {
  use(cwd2);
  const [learned, recalled] = await Promise.all([
    tool.execute("t97", { action: "learn", content: "serialized witness" }),
    tool.execute("t98", { action: "recall", query: "serialized" }),
  ]);
  assert.equal(learned.isError, undefined);
  assert.ok(
    recalled.details.hits.some((h) => h.content === "serialized witness"),
  );
  const [recalled2] = await Promise.all([
    tool.execute("t99", { action: "recall", query: "serialized" }),
    tool.execute("t9a", { action: "learn", content: "later witness" }),
  ]);
  assert.ok(
    recalled2.details.hits.every((h) => h.content !== "later witness"),
    "recall queued before learn must not see it",
  );
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});
