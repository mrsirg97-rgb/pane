import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtension, loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

const kit = await loadExtension(join(EXT_DIR, "_render-kit.mjs"));
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
  ...over,
});

function renderedText(component, width = 60) {
  return component.render(width).join("\n");
}

test("status reflects the execution lifecycle", () => {
  assert.equal(kit.status(ctx({ executionStarted: false })), "pending");
  assert.equal(kit.status(ctx({ isPartial: true })), "running");
  assert.equal(kit.status(ctx({ isError: true })), "fail");
  assert.equal(kit.status(ctx()), "ok");
});

test("header renders glyph, name, detail on one line", () => {
  const line = renderedText(kit.header(theme, ctx(), "fetch", "example.com"));
  assert.match(line, /● fetch · example\.com/);
  assert.equal(
    renderedText(kit.header(theme, ctx({ isError: true }), "todo")).includes(
      "✕ todo",
    ),
    true,
  );
});

test("shortUrl strips protocol and middle-ellipsizes", () => {
  assert.equal(kit.shortUrl("https://docs.rs/memchr/"), "docs.rs/memchr");
  const long = kit.shortUrl("https://example.com/" + "a".repeat(100), 40);
  assert.ok(long.length <= 40);
  assert.match(long, /…/);
});

test("preview collapses head and tail with a count hint", () => {
  const body = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
  const head = renderedText(
    kit.preview(theme, ctx(), body, { lines: 3, keep: "head" }),
  );
  assert.match(head, /line1[\s\S]*line3/);
  assert.doesNotMatch(head, /line4\b/);
  assert.match(head, /\+9 lines/);
  const tail = renderedText(
    kit.preview(theme, ctx(), body, { lines: 3, keep: "tail" }),
  );
  assert.match(tail, /line10[\s\S]*line12/);
  assert.match(tail.split("\n")[0], /\+9 lines/);
});

test("preview expands fully and handles empty output", () => {
  const body = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
  const expanded = renderedText(
    kit.preview(theme, ctx({ expanded: true }), body, { lines: 3 }),
  );
  assert.match(expanded, /line12/);
  assert.doesNotMatch(expanded, /\+9 lines/);
  assert.match(
    renderedText(kit.preview(theme, ctx(), "  \n ", {})),
    /no output/,
  );
});

test("progressBar scales to segments", () => {
  assert.equal(kit.progressBar(theme, 0, 8), "▱▱▱▱▱▱▱▱");
  assert.equal(kit.progressBar(theme, 4, 8), "▰▰▰▰▱▱▱▱");
  assert.equal(kit.progressBar(theme, 7, 7), "▰▰▰▰▰▰▰▰");
  assert.equal(kit.progressBar(theme, 0, 0), "▱▱▱▱▱▱▱▱");
});

for (const width of [60, 34]) {
  test(`tool renderers survive width ${width} end to end`, async () => {
    const cases = [
      {
        file: "todo.ts",
        args: { action: "start", id: "t2" },
        result: {
          content: [{ type: "text", text: "x" }],
          details: {
            action: "start",
            tasks: [
              { id: "t1", text: "guard the fetch boundary", status: "done" },
              {
                id: "t2",
                text: "wire the DI seam through the tests",
                status: "in_progress",
              },
              { id: "t3", text: "write the failing tests", status: "pending" },
              { id: "t4", text: "flaky e2e", status: "failed" },
            ],
          },
        },
        expectCall: /todo · start t2/,
        expectResult:
          /▰[▰▱]+ 1\/4 · next t3[\s\S]*● t1[\s\S]*◐ t2[\s\S]*○ t3[\s\S]*✕ t4/,
      },
      {
        file: "python-kernel.ts",
        args: {
          code: "import pandas as pd\ndf = pd.DataFrame()\nprint(len(df))",
        },
        result: {
          content: [{ type: "text", text: "0\n[stderr]\nwarning: x" }],
          details: {},
        },
        expectCall: /python · 3 lines[\s\S]*import pandas/,
        expectResult: /0[\s\S]*\[stderr\][\s\S]*warning: x/,
      },
      {
        file: "web-search.ts",
        args: { query: "rust simd memchr" },
        result: {
          content: [{ type: "text", text: "[]" }],
          details: {
            results: [
              {
                title: "memchr - crates.io",
                url: "https://crates.io/crates/memchr",
                snippet: "",
              },
              {
                title: "SIMD string search",
                url: "https://burntsushi.net/simd",
                snippet: "",
              },
            ],
          },
        },
        expectCall: /search · rust simd memchr/,
        expectResult:
          /1 memchr - crates\.io[\s\S]*crates\.io\/crates\/memchr[\s\S]*2 SIMD/,
      },
      {
        file: "web-fetch.ts",
        args: { url: "https://en.wikipedia.org/wiki/Forward_chaining" },
        result: {
          content: [
            {
              type: "text",
              text: "Forward chaining is one of the two main methods.\nMore text.",
            },
          ],
          details: {
            finalUrl: "https://en.wikipedia.org/wiki/Forward_chaining",
            status: 200,
            contentType: "text/html; charset=UTF-8",
            chars: 3209,
            truncated: true,
          },
        },
        expectCall: /fetch ·[\s\S]*en\.wikipedia\.org\/wiki\/Forward_chai/,
        expectResult:
          /200 · text\/html · 3\.1k chars ·[\s\S]*truncated[\s\S]*Forward chaining/,
      },
    ];
    for (const c of cases) {
      const { tool } = await loadExtensionTool(join(EXT_DIR, c.file));
      assert.equal(tool.renderShell, "self", `${c.file} renders its own shell`);
      const callText = renderedText(
        tool.renderCall(c.args, theme, ctx()),
        width,
      );
      assert.match(callText, c.expectCall, `${c.file} call render`);
      const resultText = renderedText(
        tool.renderResult(
          c.result,
          { expanded: false, isPartial: false },
          theme,
          ctx(),
        ),
        width,
      );
      assert.match(resultText, c.expectResult, `${c.file} result render`);
      for (const line of resultText.split("\n")) {
        assert.ok(!line.includes("\t"), "no tabs in rendered output");
      }
      const errorRender = renderedText(
        tool.renderResult(
          {
            content: [{ type: "text", text: "boom" }],
            isError: true,
            details: {},
          },
          { expanded: false, isPartial: false },
          theme,
          ctx({ isError: true }),
        ),
        width,
      );
      assert.ok(errorRender.length > 0, `${c.file} renders errors`);
    }
  });
}

test("renderers tolerate streaming/incomplete args", async () => {
  for (const file of [
    "todo.ts",
    "python-kernel.ts",
    "web-search.ts",
    "web-fetch.ts",
  ]) {
    const { tool } = await loadExtensionTool(join(EXT_DIR, file));
    const partial = ctx({
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
    });
    const line = renderedText(tool.renderCall(undefined, theme, partial));
    assert.match(line, /○ /, `${file} pending glyph with no args`);
  }
});
