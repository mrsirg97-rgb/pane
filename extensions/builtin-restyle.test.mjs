import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

const { tools, exports: ext } = await loadExtensionTool(join(EXT_DIR, "builtin-restyle.ts"));
const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
};
const ctx = (over = {}) => ({
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  isError: false,
  expanded: false,
  state: {},
  cwd: "/home/ng/Projects",
  ...over,
});
const textResult = (text, over = {}) => ({ content: [{ type: "text", text }], details: {}, ...over });

function rendered(component, width = 60) {
  return component.render(width).join("\n");
}

test("all six built-ins are overridden with self shell and intact execution", () => {
  assert.deepEqual([...tools.keys()].sort(), ["bash", "find", "grep", "ls", "read", "write"]);
  for (const [name, def] of tools) {
    assert.equal(def.renderShell, "self", `${name} self shell`);
    assert.equal(typeof def.execute, "function", `${name} keeps execute`);
    assert.ok(def.description?.length, `${name} keeps description`);
    assert.ok(Object.keys(def.parameters?.properties ?? {}).length, `${name} keeps schema`);
    assert.match(rendered(def.renderCall(undefined, theme, ctx({ executionStarted: false }))), /○ /, `${name} pending glyph`);
  }
});

test("bash call shows $ command with multiline and timeout hints", () => {
  const bash = tools.get("bash");
  assert.match(rendered(bash.renderCall({ command: "echo hi" }, theme, ctx())), /● bash · \$ echo hi/);
  const multi = rendered(bash.renderCall({ command: "a\nb\nc", timeout: 30 }, theme, ctx()));
  assert.match(multi, /\$ a \+2 lines \(timeout 30s\)/);
});

test("bash result appends a duration and previews the tail", () => {
  const bash = tools.get("bash");
  const state = { startedAt: Date.now() - 1500 };
  const out = rendered(
    bash.renderResult(textResult(Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n")), { expanded: false, isPartial: false }, theme, ctx({ state })),
  );
  assert.match(out, /l12/);
  assert.doesNotMatch(out, /\bl1\b/);
  assert.match(out, /\+6 lines/);
  assert.match(out, /\d\.\ds/);
  assert.ok(state.endedAt !== undefined, "endedAt pinned on final result");
});

test("paths shorten against cwd and home", () => {
  assert.equal(ext.shortPath("/home/ng/Projects/lift/main.c", "/home/ng/Projects"), "lift/main.c");
  assert.equal(ext.shortPath(homedir() + "/.pi/agent/settings.json", "/x"), "~/.pi/agent/settings.json");
  assert.equal(ext.shortPath("/etc/hosts", "/x"), "/etc/hosts");
  const long = ext.shortPath("/home/ng/Projects/" + "d/".repeat(40) + "f.ts", "/x");
  assert.ok(long.length <= 44);
  assert.match(long, /…/);
});

test("read call shows path with range, result previews the head", () => {
  const read = tools.get("read");
  const call = rendered(read.renderCall({ path: "/home/ng/Projects/lift/main.c", offset: 10, limit: 40 }, theme, ctx()));
  assert.match(call, /● read · lift\/main\.c \(from 10 · 40 lines\)/);
  const out = rendered(read.renderResult(textResult("1\n2\n3\n4\n5\n6\n7"), { expanded: false, isPartial: false }, theme, ctx()));
  assert.match(out, /1[\s\S]*4/);
  assert.doesNotMatch(out, /\b7\b/);
});

test("write, grep, find, ls calls carry their key argument", () => {
  const at = (name, args) => rendered(tools.get(name).renderCall(args, theme, ctx()));
  assert.match(at("write", { path: "/home/ng/Projects/x.ts", content: "a\nb" }), /● write · x\.ts 2 lines/);
  assert.match(at("grep", { pattern: "fetchGuarded", path: "/home/ng/Projects/lift", glob: "*.c" }), /● grep · fetchGuarded in lift \*\.c/);
  assert.match(at("find", { pattern: "*.test.mjs" }), /● find · \*\.test\.mjs/);
  assert.match(at("ls", { path: "/home/ng/Projects" }), /● ls · \./);
});

test("errors render as error text, width 34 stays intact", () => {
  for (const [name, def] of tools) {
    const err = rendered(
      def.renderResult(textResult("boom: something broke", { isError: true }), { expanded: false, isPartial: false }, theme, ctx({ isError: true })),
      34,
    );
    assert.match(err, /boom/, `${name} error body`);
    const ok = rendered(def.renderResult(textResult("fine"), { expanded: false, isPartial: false }, theme, ctx()), 34);
    assert.match(ok, /fine/, `${name} ok body at width 34`);
  }
});
