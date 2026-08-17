import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

const { handlers, exports: guard } = await loadExtensionTool(
  join(EXT_DIR, "compact-guard.ts"),
  {
    requireTool: false,
  },
);

const { MODEL_ROWS, GLOBAL_RESERVE, reserveOf, triggerOf, decide } = guard;

function tuiCtx(model) {
  const notes = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (msg) => notes.push(msg) },
    model,
  };
  return { ctx, notes };
}

function headlessCtx(model) {
  const lines = [];
  const ctx = {
    hasUI: false,
    ui: { notify: () => assert.fail("notify must not be used headless") },
    model,
  };
  return { ctx, lines, push: (l) => lines.push(l) };
}

function compactEvent(tokensBefore, { reason = "threshold" } = {}) {
  return {
    type: "session_before_compact",
    preparation: {
      tokensBefore,
      settings: {
        enabled: true,
        reserveTokens: GLOBAL_RESERVE,
        keepRecentTokens: 20000,
      },
    },
    branchEntries: [],
    reason,
    willRetry: false,
    signal: new AbortController().signal,
  };
}

/** Run the handler TUI-side; { model: undefined } models a missing model. */
function run(modelId, tokensBefore, over = {}) {
  const { ctx, notes } = tuiCtx(
    modelId === undefined ? undefined : { id: modelId },
  );
  const result = handlers.session_before_compact?.(
    compactEvent(tokensBefore, over),
    ctx,
  );
  return { result, notes };
}

test("64k model at 50k: under its own trigger, cancel", () => {
  const { result, notes } = run("qwen3.8-workers", 50_000);
  assert.deepEqual(result, { cancel: true });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /qwen3\.8-workers/);
  assert.match(notes[0], /cancel/);
  assert.doesNotMatch(notes[0], /proceed/);
});

test("64k model at 60k: past its own trigger, let pi proceed", () => {
  const { result, notes } = run("qwen3.8-workers", 60_000);
  assert.equal(result, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /proceed/);
  assert.doesNotMatch(notes[0], /cancel/);
});

test("262k model at 200k: under its own trigger, cancel", () => {
  const { result, notes } = run("huihui3.8", 200_000);
  assert.deepEqual(result, { cancel: true });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /huihui3\.8/);
  assert.match(notes[0], /cancel/);
});

test("262k model at 210k: past its own trigger, let pi proceed", () => {
  const { result, notes } = run("huihui3.8", 210_000);
  assert.equal(result, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /proceed/);
});

test("boundary is strict: exactly the trigger cancels, one over proceeds", () => {
  for (const id of ["qwen3.8-workers", "huihui3.8"]) {
    const trigger = triggerOf(MODEL_ROWS[id]);
    assert.equal(
      decide(MODEL_ROWS[id], trigger).cancel,
      true,
      `${id} @ trigger`,
    );
    assert.equal(
      decide(MODEL_ROWS[id], trigger + 1).cancel,
      false,
      `${id} @ trigger+1`,
    );
  }
});

test("manual /compact is user intent: not the guard's call", () => {
  const { result, notes } = run("qwen3.8-workers", 50_000, {
    reason: "manual",
  });
  assert.equal(result, undefined);
  assert.equal(notes.length, 0);
});

test("overflow recovery is already past the window: not the guard's call", () => {
  const { result, notes } = run("qwen3.8-workers", 50_000, {
    reason: "overflow",
  });
  assert.equal(result, undefined);
  assert.equal(notes.length, 0);
});

test("unknown model: pi's own math stands, no log", () => {
  const { result, notes } = run("somenewmodel", 50_000);
  assert.equal(result, undefined);
  assert.equal(notes.length, 0);
});

test("no model on ctx: pi's own math stands, no log", () => {
  const { result, notes } = run(undefined, 50_000);
  assert.equal(result, undefined);
  assert.equal(notes.length, 0);
});

test("the pi-bug shape (reserve >= window) is unreachable", () => {
  assert.ok(Object.keys(MODEL_ROWS).length >= 4, "all four models have rows");
  for (const [id, row] of Object.entries(MODEL_ROWS)) {
    // the global reserve must fit inside every window (81216 > 65536 was the 2026-08-15 bug)
    assert.ok(
      GLOBAL_RESERVE < row.window,
      `${id}: global reserve ${GLOBAL_RESERVE} must be < window ${row.window}`,
    );
    // the row's own reserve must fit inside its window (rig's Check invariant)
    assert.ok(
      reserveOf(row) < row.window,
      `${id}: reserve ${reserveOf(row)} must be < window ${row.window}`,
    );
    // so the trigger is a positive boundary, never <= 0 (compact every estimate)
    assert.ok(triggerOf(row) > 0, `${id}: trigger must be > 0`);
  }
});

test("the table mirrors rig's models.Defaults (SPEC_COMPACT 2)", () => {
  // rig models/models.go: qwen3.8-workers Window 65536, MaxTokens 8192
  assert.deepEqual(
    {
      window: MODEL_ROWS["qwen3.8-workers"].window,
      maxTokens: MODEL_ROWS["qwen3.8-workers"].maxTokens,
    },
    { window: 65_536, maxTokens: 8_192 },
  );
  // rig's 262k brain row: Window 262144
  assert.equal(MODEL_ROWS["huihui3.8"].window, 262_144);
  // windows match ~/.pi/agent/models.json for every row
  assert.equal(MODEL_ROWS["deepriver"].window, 393_216);
  assert.equal(MODEL_ROWS["huihui0731"].window, 393_216);
});

test("reserve is derived as maxTokens + 0.1*window, rounded", () => {
  for (const row of Object.values(MODEL_ROWS)) {
    assert.equal(reserveOf(row), Math.round(row.maxTokens + 0.1 * row.window));
  }
});

test("per-row reserve override wins (rig's exact 64k row: reserve 8192)", () => {
  const rigRow = { window: 65_536, maxTokens: 8_192, reserve: 8_192 };
  // trigger 57344: exactly at it cancels, one over proceeds
  assert.equal(decide(rigRow, 57_344).cancel, true);
  assert.equal(decide(rigRow, 57_345).cancel, false);
});

test("headless: the one line goes to the console, not the UI", () => {
  const { ctx, lines } = headlessCtx({ id: "qwen3.8-workers" });
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const result = handlers.session_before_compact?.(compactEvent(50_000), ctx);
    assert.deepEqual(result, { cancel: true });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[compact-guard\]/);
    assert.match(lines[0], /cancel/);
  } finally {
    console.log = orig;
  }
});
