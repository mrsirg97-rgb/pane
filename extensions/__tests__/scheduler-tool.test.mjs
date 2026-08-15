import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EXT_DIR,
  loadExtension,
  scratchDir,
  textOf,
} from "./_test-helpers.mjs";

process.env.TZ = "UTC";

const mod = await loadExtension(join(EXT_DIR, "scheduler.ts"));
const store = await loadExtension(join(EXT_DIR, "scheduler/store.ts"));
const REPO_MJS = resolve(join(EXT_DIR, "scheduler/runner.mjs"));

const NOW = () => new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
const CTX = { sessionManager: { getSessionId: () => "sess-tool" } };

function fakeCrontab(initial = "SHELL=/bin/bash\n") {
  const ct = { text: initial };
  ct.list = async () => ct.text;
  ct.install = async (t) => {
    ct.text = t;
  };
  return ct;
}

function setupTool(over = {}) {
  const home = scratchDir();
  const cwd = over.cwd ?? scratchDir();
  mkdirSync(cwd, { recursive: true });
  const crontab = over.crontab ?? fakeCrontab();
  let tool = null;
  const api = {
    registerTool: (t) => (tool = t),
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on() {},
  };
  mod.default(api, {
    home,
    crontab,
    now: NOW,
    lockProbe: over.lockProbe,
  });
  assert.ok(tool, "tool registered");
  const prevCwd = process.cwd();
  process.chdir(cwd);
  const exec = (id, params) =>
    tool.execute(id, params, undefined, undefined, CTX);
  return {
    tool,
    home,
    cwd,
    crontab,
    exec,
    done: () => process.chdir(prevCwd),
  };
}

// ---- surface ----

test("tool surface: name, actions, params, renderers", async () => {
  const s = setupTool();
  s.done();
  const t = s.tool;
  assert.equal(t.name, "scheduler");
  assert.equal(typeof t.execute, "function");
  assert.equal(typeof t.renderCall, "function");
  assert.equal(typeof t.renderResult, "function");
  const props = Object.keys(t.parameters.properties).sort();
  for (const p of [
    "action",
    "at",
    "busy",
    "cwd",
    "cron",
    "id",
    "model",
    "n",
    "name",
    "prompt",
    "scope",
  ])
    assert.ok(props.includes(p), `param ${p}`);
  assert.match(t.description, /crontab/i);
});

// ---- create + list round-trip ----

test("create (default cwd scope) then list; store file and crontab line land in the right places", async () => {
  const s = setupTool();
  try {
    const r = await s.exec("t1", {
      action: "create",
      name: "nightly",
      prompt: "do it",
      cron: "0 */4 * * *",
    });
    const text = textOf(r);
    assert.match(text, /j1/);
    assert.match(text, /active/);

    const hash = store.cwdHash(s.cwd);
    assert.ok(existsSync(join(s.home, `${hash}.sqlite`)), "cwd store file");
    assert.ok(!existsSync(join(s.home, "global.sqlite")), "global untouched");
    assert.ok(
      s.crontab.text.includes(`pane-scheduler:cwd-${hash}:j1`),
      "tagged line",
    );
    assert.ok(
      s.crontab.text.includes("SHELL=/bin/bash"),
      "foreign line intact",
    );

    const list = await s.exec("t2", { action: "list" });
    const lt = textOf(list);
    assert.match(lt, /nightly/);
    assert.match(lt, /cwd:/);
    assert.ok(!/drift/.test(lt), "no drift on a clean job");

    const db = new DatabaseSync(join(s.home, `${hash}.sqlite`));
    const ev = db.prepare("SELECT session FROM events WHERE op='create'").get();
    db.close();
    assert.equal(ev.session, "sess-tool", "session stamped on the event");
  } finally {
    s.done();
  }
});

test("create with scope=global uses the global store and a bare key", async () => {
  const s = setupTool();
  try {
    const r = await s.exec("t1", {
      action: "create",
      name: "daily",
      prompt: "p",
      cron: "30 1 * * *",
      scope: "global",
    });
    assert.match(textOf(r), /global/);
    assert.ok(existsSync(join(s.home, "global.sqlite")));
    assert.ok(s.crontab.text.includes("pane-scheduler:j1"));
  } finally {
    s.done();
  }
});

test("create validation: missing name and bad cron refuse loudly", async () => {
  const s = setupTool();
  try {
    await assert.rejects(
      s.exec("t1", { action: "create", prompt: "p", cron: "0 0 * * *" }),
      /name/,
    );
    await assert.rejects(
      s.exec("t2", {
        action: "create",
        name: "x",
        prompt: "p",
        cron: "* * * *",
      }),
      /cron/,
    );
    assert.ok(!s.crontab.text.includes("pane-scheduler:"));
  } finally {
    s.done();
  }
});

// ---- state actions ----

test("pause/resume/remove via the tool; ambiguity refuses without scope", async () => {
  const s = setupTool();
  try {
    await s.exec("t1", {
      action: "create",
      name: "cw",
      prompt: "p",
      cron: "0 5 * * *",
    });
    await s.exec("t2", {
      action: "create",
      name: "gl",
      prompt: "p",
      cron: "0 6 * * *",
      scope: "global",
    });

    await assert.rejects(
      s.exec("t3", { action: "pause", id: "j1" }),
      /ambiguous/,
    );
    const paused = await s.exec("t4", {
      action: "pause",
      id: "j1",
      scope: "cwd",
    });
    assert.match(textOf(paused), /paused/);
    assert.ok(
      s.crontab.text.includes("# 0 5 * * *"),
      "cwd line commented (global line untouched)",
    );
    assert.ok(
      !s.crontab.text.includes("# 0 6 * * *"),
      "global line still active",
    );

    const resumed = await s.exec("t5", {
      action: "resume",
      id: "j1",
      scope: "cwd",
    });
    assert.match(textOf(resumed), /active/);

    const removed = await s.exec("t6", {
      action: "remove",
      id: "j1",
      scope: "cwd",
    });
    assert.match(textOf(removed), /removed/);
    const list = await s.exec("t7", { action: "list" });
    assert.ok(!textOf(list).includes("j1 cw"), "removed job not listed");
    assert.match(textOf(list), /gl/);
  } finally {
    s.done();
  }
});

// ---- runs ----

test("runs returns the audit trail", async () => {
  const s = setupTool();
  try {
    await s.exec("t1", {
      action: "create",
      name: "busy",
      prompt: "p",
      cron: "0 7 * * *",
    });
    const path = join(s.home, `${store.cwdHash(s.cwd)}.sqlite`);
    const db = new DatabaseSync(path);
    store.appendEvent(
      db,
      "run",
      {
        id: "j1",
        status: "ok",
        exit: 0,
        durationMs: 10,
        log: "runs/x/a.log",
        reason: null,
      },
      null,
    );
    store.appendEvent(
      db,
      "run",
      {
        id: "j1",
        status: "skip",
        exit: null,
        durationMs: null,
        log: null,
        reason: "busy: x resident (policy skip)",
      },
      null,
    );
    db.close();

    const r = await s.exec("t2", { action: "runs", id: "j1" });
    const text = textOf(r);
    assert.match(text, /ok/);
    assert.match(text, /skip/);
    assert.match(text, /busy: x resident/);

    await assert.rejects(
      s.exec("t3", { action: "runs", id: "j99" }),
      /no job 'j99'/,
    );
  } finally {
    s.done();
  }
});

// ---- deploy ----

test("first execute deploys runner.sh + runner.mjs into the home", async () => {
  const s = setupTool();
  try {
    await s.exec("t1", { action: "list" });
    const sh = join(s.home, "runner.sh");
    const mjs = join(s.home, "runner.mjs");
    assert.ok(existsSync(sh));
    assert.ok(existsSync(mjs));
    assert.ok(statSync(sh).mode & 0o111, "runner.sh executable");
    assert.equal(
      readFileSync(mjs, "utf8"),
      readFileSync(REPO_MJS, "utf8"),
      "deployed == repo",
    );
  } finally {
    s.done();
  }
});

// ---- render ----

test("renderCall and renderResult", async () => {
  const s = setupTool();
  s.done();
  const theme = { fg: (_token, text) => String(text), bold: (t) => String(t) };
  const call = s.tool.renderCall({ action: "pause", id: "j1" }, theme, {});
  assert.ok(
    String(call ?? "").length > 0 || call?.constructor?.name === "Text",
  );

  const err = s.tool.renderResult(
    { isError: true, content: [{ type: "text", text: "boom" }] },
    {},
    theme,
    {},
  );
  assert.match(String(err?.text ?? err), /boom/);

  const job = {
    id: "j1",
    name: "nightly",
    prompt: "p",
    cron: "0 */4 * * *",
    at: null,
    cwd: "/ws",
    model: "qwen3.8-workers",
    busy: "skip",
    state: "active",
    scope: "cwd",
    nextFire: "2026-08-15T16:00:00.000Z",
    lastStatus: null,
    lastTs: null,
    lastExit: null,
    running: false,
    drift: null,
  };
  const ok = s.tool.renderResult(
    { content: [{ type: "text", text: "" }], details: { job } },
    {},
    theme,
    {},
  );
  const rendered = String(ok?.text ?? ok);
  assert.match(rendered, /nightly/);
  assert.match(rendered, /16:00/);
});
