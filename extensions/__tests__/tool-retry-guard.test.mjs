import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

const { handlers } = await loadExtensionTool(
  join(EXT_DIR, "tool-retry-guard.ts"),
  {
    requireTool: false,
  },
);

function failureEvent(over = {}) {
  return {
    toolName: "todo",
    isError: true,
    content: [{ type: "text", text: "todo: no task 't9'" }],
    details: { ok: false },
    ...over,
  };
}
function successEvent(over = {}) {
  return {
    toolName: "todo",
    isError: false,
    content: [{ type: "text", text: "ok" }],
    details: {},
    ...over,
  };
}
function turnStart() {
  return handlers.turn_start?.({ turnIndex: 1, timestamp: Date.now() });
}
function result(ev) {
  return handlers.tool_result?.(ev);
}
function armBreaker(over = {}) {
  const ev = failureEvent(over);
  result(ev);
  result(ev);
  return result(ev);
}
/** The guard note is appended, so it is always the last content block. */
function note(patch) {
  return patch.content[patch.content.length - 1].text;
}

test("failures below the limit pass through untouched", () => {
  turnStart();
  const a = result(failureEvent());
  const b = result(failureEvent());
  assert.equal(a, undefined);
  assert.equal(b, undefined);
});

test("the limit failure appends a stop signal to the real error", () => {
  turnStart();
  const patch = armBreaker();
  assert.ok(patch, "third consecutive failure must patch the result");
  assert.deepEqual(patch.content[0], {
    type: "text",
    text: "todo: no task 't9'",
  });
  assert.equal(patch.content.length, 2);
  assert.match(note(patch), /failed 3× in a row/);
  assert.match(note(patch), /stop calling this tool/);
  assert.deepEqual(patch.details.retryGuard, { tool: "todo", failures: 3 });
});

test("further failures keep the guard message and grow the count", () => {
  const patch = result(failureEvent());
  assert.match(note(patch), /failed 4×/);
  assert.equal(patch.details.retryGuard.failures, 4);
});

test("a success resets the streak", () => {
  assert.equal(result(successEvent()), undefined);
  assert.equal(result(failureEvent()), undefined);
  assert.equal(result(failureEvent()), undefined);
});

test("turn_start resets all counters", () => {
  turnStart();
  assert.equal(result(failureEvent()), undefined);
  assert.equal(result(failureEvent()), undefined);
  turnStart();
  assert.equal(result(failureEvent()), undefined);
});

test("non-error results never patch and reset the streak", () => {
  turnStart();
  assert.equal(result(successEvent({ toolName: "bash" })), undefined);
  assert.equal(result(failureEvent({ toolName: "bash" })), undefined);
  assert.equal(result(failureEvent({ toolName: "bash" })), undefined);
});

test("missing toolName is ignored", () => {
  turnStart();
  assert.equal(result(failureEvent({ toolName: undefined })), undefined);
});

test("non-text content blocks are passed through untouched", () => {
  turnStart();
  const content = [
    { type: "image", data: "abc", mimeType: "image/png" },
    { type: "text", text: "first line" },
    { type: "text", text: "second line" },
  ];
  const patch = armBreaker({ content });
  assert.deepEqual(patch.content.slice(0, 3), content);
  assert.equal(patch.content.length, 4);
});

test("huge errors survive in full — pi does its own truncation", () => {
  turnStart();
  const big = "e".repeat(5000);
  const patch = armBreaker({ content: [{ type: "text", text: big }] });
  assert.equal(patch.content[0].text, big);
  assert.match(note(patch), /The error is above/);
});

test("a missing content array still yields the note", () => {
  turnStart();
  const patch = armBreaker({ content: undefined });
  assert.equal(patch.content.length, 1);
  assert.match(note(patch), /failed 3×/);
});

test("works for any tool, not just todo", () => {
  turnStart();
  const patch = armBreaker({ toolName: "bash" });
  assert.match(note(patch), /bash failed 3×/);
});

test("details are preserved alongside the retryGuard flag", () => {
  turnStart();
  const patch = armBreaker({ details: { ok: false, depth: 2 } });
  assert.equal(patch.details.ok, false);
  assert.equal(patch.details.depth, 2);
  assert.equal(patch.details.retryGuard.failures, 3);
});

test("isError is left true (patch omits it)", () => {
  turnStart();
  const patch = armBreaker();
  assert.equal("isError" in patch, false);
});
