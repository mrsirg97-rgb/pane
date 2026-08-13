import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

const { handlers } = await loadExtensionTool(join(EXT_DIR, "input.ts"), { requireTool: false });

const fakeTui = { terminal: { rows: 30, cols: 80 }, requestRender() {} };
const editorTheme = { borderColor: (s) => s, selectList: {} };
const fakeKeybindings = { matches: () => false };

function makeEditor(ctxOver = {}) {
  let factory = null;
  const ctx = {
    mode: "tui",
    ui: {
      setEditorComponent: (f) => (factory = f),
      theme: { fg: (color, text) => `<${color}>${text}` },
    },
    ...ctxOver,
  };
  handlers.session_start({}, ctx);
  assert.ok(factory, "editor factory registered");
  const editor = factory(fakeTui, editorTheme, fakeKeybindings);
  editor.focused = true;
  return { editor, ctx };
}

function bare(rows) {
  return rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
}

test("muted bars frame the input and the glyph leads the first content line", () => {
  const { editor } = makeEditor();
  editor.setText("hello world");
  const rows = editor.render(40);
  assert.match(rows[0], /<borderMuted>─+/, "top bar painted muted");
  assert.match(rows[rows.length - 1], /<borderMuted>─+/, "bottom bar painted muted");
  assert.match(rows[1], /<accent>❯ /);
  assert.match(bare(rows).join("\n"), /hello world/);
});

test("only the first line of multi-line input carries the glyph", () => {
  const { editor } = makeEditor();
  editor.setText("first\nsecond\nthird");
  const rows = editor.render(40);
  const glyphRows = rows.filter((r) => r.includes("❯"));
  assert.equal(glyphRows.length, 1);
  assert.match(rows[1], /❯/);
  assert.match(bare(rows)[2], /^  second/);
});

test("streaming swaps to a dim ◐ and back", () => {
  const { editor } = makeEditor();
  editor.setText("queued steer");
  handlers.agent_start({}, {});
  assert.match(editor.render(40)[1], /<dim>◐ /);
  handlers.agent_end({}, {});
  assert.match(editor.render(40)[1], /<accent>❯ /);
});

test("unfocused editor dims the prompt", () => {
  const { editor } = makeEditor();
  editor.focused = false;
  editor.setText("x");
  assert.match(editor.render(40)[1], /<dim>❯ /);
});

test("scroll indicators survive when input overflows", () => {
  const { editor } = makeEditor();
  const tall = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  editor.setText(tall);
  const rows = editor.render(40);
  assert.match(bare(rows).join("\n"), /more/, "overflow indicator present");
});

test("narrow width renders without crashing and keeps the glyph", () => {
  const { editor } = makeEditor();
  editor.setText("a reasonably long steering instruction for the model");
  const rows = editor.render(24);
  assert.match(rows.join("\n"), /❯/);
  assert.ok(rows.length > 2);
});

test("non-tui sessions leave the editor alone", () => {
  let called = false;
  handlers.session_start({}, { mode: "print", ui: { setEditorComponent: () => (called = true), theme: { fg: (c, t) => t } } });
  assert.equal(called, false);
});
