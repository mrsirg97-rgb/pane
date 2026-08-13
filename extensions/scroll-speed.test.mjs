import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadExtension, EXT_DIR } from "./_test-helpers.mjs";

const ext = await loadExtension(join(EXT_DIR, "scroll-speed.ts"));
const { applyWheelBoost } = ext;

function fakeProto() {
  const calls = [];
  return {
    calls,
    routeWheel(event) {
      calls.push(event);
    },
  };
}

test("wheel events are multiplied, other fields preserved", () => {
  const proto = fakeProto();
  assert.equal(applyWheelBoost(proto, 3), true);
  proto.routeWheel({ direction: 1, x: 4, y: 7 });
  proto.routeWheel({ direction: -1, x: 0, y: 0 });
  assert.deepEqual(proto.calls[0], { direction: 3, x: 4, y: 7 });
  assert.equal(proto.calls[1].direction, -3);
});

test("double patching is refused", () => {
  const proto = fakeProto();
  assert.equal(applyWheelBoost(proto, 3), true);
  assert.equal(applyWheelBoost(proto, 3), false);
  proto.routeWheel({ direction: 1, x: 0, y: 0 });
  assert.equal(proto.calls[0].direction, 3, "still 3x, not 9x");
});

test("factor 1 and missing routeWheel are no-ops", () => {
  const proto = fakeProto();
  assert.equal(applyWheelBoost(proto, 1), false);
  proto.routeWheel({ direction: 1, x: 0, y: 0 });
  assert.equal(proto.calls[0].direction, 1);
  assert.equal(applyWheelBoost({}, 3), false);
});

test("extension patches the real TuiAltScreen prototype", async () => {
  const { PI_PKG } = await import("./_test-helpers.mjs");
  const { pathToFileURL } = await import("node:url");
  const tui = await import(pathToFileURL(join(PI_PKG, "node_modules/@earendil-works/pi-tui/dist/index.js")).href);
  const factory = typeof ext.default === "function" ? ext.default : ext;
  factory({});
  assert.equal(tui.TuiAltScreen.prototype[Symbol.for("pi.scrollSpeedBoost")], true);
});
