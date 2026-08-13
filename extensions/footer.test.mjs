import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

const { handlers, exports: ext } = await loadExtensionTool(join(EXT_DIR, "footer.ts"), { requireTool: false });
const { buildFooterLines, collectUsage, formatTokens } = ext;

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
};

function state(over = {}) {
  return {
    modelId: "deepriver",
    reasoning: true,
    thinkingLevel: "max",
    contextUsage: { tokens: 57_000, contextWindow: 393_216, percent: 14.5 },
    usage: { input: 2100, output: 15_400, cacheRead: 50_000, cacheWrite: 3000, cacheHitRate: 92.3 },
    branch: "main",
    autoCompact: true,
    statuses: [],
    ...over,
  };
}

test("formatTokens compacts like the stock footer", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(2100), "2.1k");
  assert.equal(formatTokens(57_000), "57k");
  assert.equal(formatTokens(393_216), "393k");
  assert.equal(formatTokens(1_500_000), "1.5M");
});

test("row one: model, thinking, context, right-aligned branch", () => {
  const [modelLine] = buildFooterLines(state(), theme, 60);
  assert.match(modelLine, /^deepriver · max · 57k\/393k 15% \(auto\)\s+main$/);
  assert.equal(modelLine.length, 60);
});

test("row one drops branch when narrow, hides thinking for non-reasoning models", () => {
  const [narrow] = buildFooterLines(state({ branch: "a-very-long-branch-name-that-cannot-fit-here" }), theme, 30);
  assert.doesNotMatch(narrow, /branch-name/);
  const [plain] = buildFooterLines(state({ reasoning: false }), theme, 60);
  assert.doesNotMatch(plain, /max/);
});

test("row two: throughput and cache only, context lives on row one", () => {
  const [, stats] = buildFooterLines(state(), theme, 80);
  assert.doesNotMatch(stats, /393k/);
  assert.match(stats, /↑2\.1k ↓15k/);
  assert.match(stats, /⛁ R50k W3\.0k 92%/);
});

test("unknown tokens after compaction; empty stats row is dropped", () => {
  const lines = buildFooterLines(
    state({
      contextUsage: { tokens: null, contextWindow: 393_216, percent: null },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      autoCompact: false,
      branch: null,
    }),
    theme,
    80,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\?\/393k/);
  assert.doesNotMatch(lines[0], /auto/);
});

test("statuses appear as a third row only when present", () => {
  assert.equal(buildFooterLines(state(), theme, 80).length, 2);
  const lines = buildFooterLines(state({ statuses: ["guard: idle"] }), theme, 80);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /guard: idle/);
});

test("collectUsage sums entries and tracks the latest cache hit rate", () => {
  const usage = collectUsage([
    { type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 300, cacheWrite: 20 } } },
    { type: "message", message: { role: "toolResult", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
    { type: "compaction", usage: { input: 40, output: 30, cacheRead: 0, cacheWrite: 0 } },
    { type: "message", message: { role: "assistant", usage: { input: 50, output: 25, cacheRead: 450, cacheWrite: 0 } } },
    { type: "session" },
  ]);
  assert.deepEqual(
    { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
    { input: 200, output: 110, cacheRead: 750, cacheWrite: 20 },
  );
  assert.equal(Math.round(usage.cacheHitRate), 90);
});

test("session_start wires a live footer through ctx.ui.setFooter", () => {
  let factory = null;
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 300, cacheWrite: 20 } } },
  ];
  const ctx = {
    mode: "tui",
    ui: { setFooter: (f) => (factory = f) },
    model: { id: "deepriver", reasoning: true },
    thinkingLevel: "max",
    getContextUsage: () => ({ tokens: 57_000, contextWindow: 393_216, percent: 14.5 }),
    sessionManager: { getEntries: () => entries },
  };
  handlers.session_start({}, ctx);
  assert.ok(factory, "footer factory registered");
  const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map() };
  const lines = factory({}, theme, footerData).render(60);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /deepriver · max · 57k\/393k 15%/);
  assert.match(lines[1], /↑100 ↓50/);
  ctx.model = { id: "qwen3.6-27b", reasoning: false };
  handlers.model_select({}, ctx);
  assert.match(factory({}, theme, footerData).render(60)[0], /qwen3\.6-27b/);
});

test("non-tui sessions leave the footer alone", () => {
  let called = false;
  handlers.session_start({}, { mode: "print", ui: { setFooter: () => (called = true) } });
  assert.equal(called, false);
});
