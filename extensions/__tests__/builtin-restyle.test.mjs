import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadExtensionTool, scratchDir, EXT_DIR } from "./_test-helpers.mjs";

const { tools, exports: ext } = await loadExtensionTool(
  join(EXT_DIR, "builtin-restyle.ts"),
);
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
const textResult = (text, over = {}) => ({
  content: [{ type: "text", text }],
  details: {},
  ...over,
});

function rendered(component, width = 60) {
  return component.render(width).join("\n");
}

test("all seven built-ins are overridden with self shell and intact execution", () => {
  assert.deepEqual([...tools.keys()].sort(), [
    "bash",
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "write",
  ]);
  for (const [name, def] of tools) {
    assert.equal(def.renderShell, "self", `${name} self shell`);
    assert.equal(typeof def.execute, "function", `${name} keeps execute`);
    assert.ok(def.description?.length, `${name} keeps description`);
    assert.ok(
      Object.keys(def.parameters?.properties ?? {}).length,
      `${name} keeps schema`,
    );
    assert.match(
      rendered(
        def.renderCall(undefined, theme, ctx({ executionStarted: false })),
      ),
      /○ /,
      `${name} pending glyph`,
    );
  }
});

test("bash call shows $ command with multiline and timeout hints", () => {
  const bash = tools.get("bash");
  assert.match(
    rendered(bash.renderCall({ command: "echo hi" }, theme, ctx())),
    /● bash · \$ echo hi/,
  );
  const multi = rendered(
    bash.renderCall({ command: "a\nb\nc", timeout: 30 }, theme, ctx()),
  );
  assert.match(multi, /\$ a\s*\n\s+\+2 lines · timeout 30s/);
});

test("bash result appends a duration and previews the tail", () => {
  const bash = tools.get("bash");
  const state = { startedAt: Date.now() - 1500 };
  const out = rendered(
    bash.renderResult(
      textResult(Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n")),
      { expanded: false, isPartial: false },
      theme,
      ctx({ state }),
    ),
  );
  assert.match(out, /l12/);
  assert.doesNotMatch(out, /\bl1\b/);
  assert.match(out, /\+6 lines/);
  assert.match(out, /\d\.\ds/);
  assert.ok(state.endedAt !== undefined, "endedAt pinned on final result");
});

test("paths shorten against cwd and home", () => {
  assert.equal(
    ext.shortPath("/home/ng/Projects/lift/main.c", "/home/ng/Projects"),
    "lift/main.c",
  );
  assert.equal(
    ext.shortPath(homedir() + "/.pi/agent/settings.json", "/x"),
    "~/.pi/agent/settings.json",
  );
  assert.equal(ext.shortPath("/etc/hosts", "/x"), "/etc/hosts");
  const long = ext.shortPath(
    "/home/ng/Projects/" + "d/".repeat(40) + "f.ts",
    "/x",
  );
  assert.ok(long.length <= 44);
  assert.match(long, /…/);
});

test("read call shows path with range, result previews the head", () => {
  const read = tools.get("read");
  const call = rendered(
    read.renderCall(
      { path: "/home/ng/Projects/lift/main.c", offset: 10, limit: 40 },
      theme,
      ctx(),
    ),
  );
  assert.match(call, /● read · lift\/main\.c\s*\n\s+from 10 · 40 lines/);
  const out = rendered(
    read.renderResult(
      textResult("1\n2\n3\n4\n5\n6\n7"),
      { expanded: false, isPartial: false },
      theme,
      ctx(),
    ),
  );
  assert.match(out, /1[\s\S]*4/);
  assert.doesNotMatch(out, /\b7\b/);
});

test("write, grep, find, ls calls carry their key argument", () => {
  const at = (name, args) =>
    rendered(tools.get(name).renderCall(args, theme, ctx()));
  assert.match(
    at("write", { path: "/home/ng/Projects/x.ts", content: "a\nb" }),
    /● write · x\.ts\s*\n\s+2 lines/,
  );
  assert.match(
    at("grep", {
      pattern: "fetchGuarded",
      path: "/home/ng/Projects/lift",
      glob: "*.c",
    }),
    /● grep · fetchGuarded\s*\n\s+in lift \*\.c/,
  );
  assert.match(at("find", { pattern: "*.test.mjs" }), /● find · \*\.test\.mjs/);
  assert.match(
    at("find", { pattern: "*.ts", path: "/home/ng/Projects/lift" }),
    /● find · \*\.ts\s*\n\s+in lift/,
  );
  assert.match(at("ls", { path: "/home/ng/Projects" }), /● ls · \./);
});

test("write result previews the written content, capped at 15 lines", () => {
  const write = tools.get("write");
  const content = Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join("\n");
  const c = ctx();
  write.renderCall({ path: "/home/ng/Projects/x.ts", content }, theme, c);
  const out = rendered(
    write.renderResult(
      textResult("Wrote 20 lines"),
      { expanded: false, isPartial: false },
      theme,
      c,
    ),
  );
  assert.match(out, /w1\b/);
  assert.match(out, /w15\b/);
  assert.doesNotMatch(out, /w16\b/);
  assert.match(out, /\+5 lines/);
  assert.doesNotMatch(out, /Wrote 20 lines/);
});

test("edit call carries path and edit count; result renders the diff", () => {
  const edit = tools.get("edit");
  const args = {
    path: "/home/ng/Projects/x.ts",
    edits: [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ],
  };
  const c = ctx();
  assert.match(
    rendered(edit.renderCall(args, theme, c)),
    /● edit · x\.ts\s*\n\s+2 edits/,
  );
  const single = rendered(
    edit.renderCall({ ...args, edits: [args.edits[0]] }, theme, ctx()),
  );
  assert.match(single, /\n\s+1 edit\b/);
  const out = rendered(
    edit.renderResult(
      textResult("ok", { details: { diff: "-1 old line\n+1 new line" } }),
      { expanded: false, isPartial: false },
      theme,
      c,
    ),
  );
  assert.match(out, /-1 old line/);
  assert.match(out, /\+1 new line/);
});

test("edit result without a diff falls back to the result text", () => {
  const edit = tools.get("edit");
  const out = rendered(
    edit.renderResult(
      textResult("nothing to do"),
      { expanded: false, isPartial: false },
      theme,
      ctx(),
    ),
  );
  assert.match(out, /nothing to do/);
});

test("write streams a live tail of the content while args arrive", () => {
  const write = tools.get("write");
  const content = Array.from({ length: 14 }, (_, i) => `s${i + 1}`).join("\n");
  const streaming = rendered(
    write.renderCall(
      { path: "/home/ng/Projects/x.ts", content },
      theme,
      ctx({ executionStarted: false, argsComplete: false }),
    ),
  );
  assert.match(streaming, /s14\b/);
  assert.match(streaming, /s5\b/);
  assert.doesNotMatch(streaming, /s4\b/);
  assert.match(streaming, /\+4 lines/);
  assert.match(streaming, /\b5 s5\b/); // real file line numbers on the tail
  assert.match(streaming, /\b14 s14\b/);
  assert.doesNotMatch(streaming, /14 lines/); // counter row waits: the tail's marker counts
  const settled = rendered(
    write.renderCall({ path: "/home/ng/Projects/x.ts", content }, theme, ctx()),
  );
  assert.doesNotMatch(settled, /s14\b/); // execution started: preview belongs to the result
});

test("edit streams a live tail of the newest edit's newText", () => {
  const edit = tools.get("edit");
  const streaming = rendered(
    edit.renderCall(
      {
        path: "/home/ng/Projects/x.ts",
        edits: [
          { oldText: "a", newText: "done" },
          { oldText: "b", newText: "line one\nline two" },
        ],
      },
      theme,
      ctx({ executionStarted: false, argsComplete: false }),
    ),
  );
  assert.match(streaming, /line one/);
  assert.match(streaming, /line two/);
  assert.doesNotMatch(streaming, /\bdone\b/); // only the newest edit streams
});

test("edit live tail anchors line numbers by locating oldText in the file", () => {
  const edit = tools.get("edit");
  const dir = scratchDir();
  const file = join(dir, "anchored.ts");
  writeFileSync(file, "one\ntwo\nthree\nfour\nfive\n");
  const streaming = rendered(
    edit.renderCall(
      {
        path: file,
        edits: [{ oldText: "three\nfour", newText: "THREE\nFOUR" }],
      },
      theme,
      ctx({ executionStarted: false, argsComplete: false }),
    ),
  );
  assert.match(streaming, /\b3 THREE\b/); // oldText starts at file line 3
  assert.match(streaming, /\b4 FOUR\b/);
  const missing = rendered(
    edit.renderCall(
      {
        path: join(dir, "nope.ts"),
        edits: [{ oldText: "x", newText: "plain" }],
      },
      theme,
      ctx({ executionStarted: false, argsComplete: false }),
    ),
  );
  assert.match(missing, /plain/);
  assert.doesNotMatch(missing, /\d plain/); // unreadable file: unnumbered fallback
});

test("live tail is memoized: unchanged args restyle nothing", () => {
  const write = tools.get("write");
  const counting = () => {
    let n = 0;
    return {
      theme: { ...theme, fg: (_c, t) => (n++, t) },
      count: () => n,
    };
  };
  const args = {
    path: "/home/ng/Projects/x.ts",
    content: Array.from({ length: 30 }, (_, i) => `m${i + 1}`).join("\n"),
  };
  const c = ctx({ executionStarted: false, argsComplete: false });
  const first = counting();
  write.renderCall(args, first.theme, c);
  const second = counting();
  write.renderCall(args, second.theme, c);
  // second pass reuses the cached tail: only header + counter restyle
  assert.ok(second.count() < first.count() / 2);
  assert.ok(c.state.liveOut.includes("m30"));
});

test("errors render as error text, width 34 stays intact", () => {
  for (const [name, def] of tools) {
    const err = rendered(
      def.renderResult(
        textResult("boom: something broke", { isError: true }),
        { expanded: false, isPartial: false },
        theme,
        ctx({ isError: true }),
      ),
      34,
    );
    assert.match(err, /boom/, `${name} error body`);
    const ok = rendered(
      def.renderResult(
        textResult("fine"),
        { expanded: false, isPartial: false },
        theme,
        ctx(),
      ),
      34,
    );
    assert.match(ok, /fine/, `${name} ok body at width 34`);
  }
});
