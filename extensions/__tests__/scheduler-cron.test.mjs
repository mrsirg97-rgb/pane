import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { EXT_DIR, loadExtension } from "./_test-helpers.mjs";

// Deterministic dates: pin UTC before any Date arithmetic.
process.env.TZ = "UTC";

const { validateCron, nextFire } = await loadExtension(
  join(EXT_DIR, "scheduler/cron.ts"),
);

const t = (y, mo, d, h = 0, mi = 0, s = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi, s, 0));
const iso = (d) => d.toISOString();

// ---- validateCron: acceptance ----

test("accepts standard 5-field expressions", () => {
  for (const expr of [
    "0 */4 * * *", // the watchdog line
    "*/15 9-17 * * 1-5",
    "5 4 * * 0",
    "0 0 1 1 *",
    "30 14 15 8 *",
    "1,2,3 0 * * *",
    "1-30/2 0 1 * *",
    "0 0 * * 7", // 7 == Sunday
    "  0   * * * *  ", // surrounding/multi whitespace
    "* * * * *",
  ]) {
    assert.doesNotThrow(() => validateCron(expr), expr);
  }
});

test("expands values and steps correctly", () => {
  const p = validateCron("0 */4 * * *");
  assert.deepEqual(p.minute.values, [0]);
  assert.deepEqual(p.hour.values, [0, 4, 8, 12, 16, 20]);
  assert.deepEqual(
    p.dom.values,
    [...Array(31).keys()].map((i) => i + 1),
  );
  assert.deepEqual(
    p.month.values,
    [...Array(12).keys()].map((i) => i + 1),
  );
  assert.deepEqual(p.dow.values, [0, 1, 2, 3, 4, 5, 6]);

  const q = validateCron("1-30/2 9-17 * * 1-5");
  assert.deepEqual(
    q.minute.values,
    [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29],
  );
  assert.deepEqual(
    q.hour.values,
    [...Array(9).keys()].map((i) => i + 9),
  );
  assert.deepEqual(q.dow.values, [1, 2, 3, 4, 5]);
});

test("dow 7 normalizes to 0 (both are Sunday)", () => {
  const p = validateCron("0 0 * * 0,7");
  assert.deepEqual(p.dow.values, [0]);
});

test("isStar tracks the vixie * prefix, for the dom/dow union", () => {
  assert.equal(validateCron("* * * * *").dom.isStar, true);
  assert.equal(validateCron("* * */2 * *").dom.isStar, true); // */2 is unrestricted
  assert.equal(validateCron("* * 5 * *").dom.isStar, false);
  assert.equal(validateCron("* * 1-5 * *").dom.isStar, false);
  assert.equal(validateCron("* * * * 7").dow.isStar, false);
});

// ---- validateCron: rejection, by boundary name ----

test("rejects wrong field counts", () => {
  assert.throws(() => validateCron("* * * *"), /5 fields/); // 4
  assert.throws(() => validateCron("* * * * * *"), /5 fields/); // 6 (seconds)
  assert.throws(() => validateCron(""), /5 fields/);
});

test("rejects @-macros", () => {
  assert.throws(() => validateCron("@daily"), /macros/);
});

test("rejects garbage and names", () => {
  assert.throws(() => validateCron("a * * * *"), /invalid/);
  assert.throws(() => validateCron("* * * jan *"), /invalid/);
  assert.throws(() => validateCron("* * * * mon"), /invalid/);
});

test("rejects out-of-range values", () => {
  assert.throws(() => validateCron("60 * * * *"), /minute.*0-59/);
  assert.throws(() => validateCron("* 24 * * *"), /hour.*0-23/);
  assert.throws(() => validateCron("* * 0 * *"), /day-of-month.*1-31/);
  assert.throws(() => validateCron("* * 32 * *"), /day-of-month.*1-31/);
  assert.throws(() => validateCron("* * * 13 *"), /month.*1-12/);
  assert.throws(() => validateCron("* * * * 8"), /day-of-week.*0-7/);
});

test("rejects wrap ranges, zero steps, and bare-number steps", () => {
  assert.throws(() => validateCron("5-1 * * * *"), /wrap/);
  assert.throws(() => validateCron("*/0 * * * *"), /step/);
  assert.throws(() => validateCron("1/5 * * * *"), /step/); // vixie: step after * or range only
});

test("rejects malformed lists and ranges", () => {
  assert.throws(() => validateCron("1,,2 * * * *"), /empty list item/);
  assert.throws(() => validateCron("*-* * * * *"), /invalid item/);
  assert.throws(() => validateCron("1- * * * *"), /invalid item/);
  assert.throws(() => validateCron("-5 * * * *"), /invalid item/);
});

// ---- nextFire: exactness ----

test("next fire of the watchdog line from just after a fire", () => {
  const p = validateCron("0 */4 * * *");
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 0, 2, 30))),
    iso(t(2026, 8, 15, 4, 0)),
  );
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 3, 59))),
    iso(t(2026, 8, 15, 4, 0)),
  );
});

test("fires strictly after the reference time", () => {
  const p = validateCron("0 */4 * * *");
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 4, 0, 0))),
    iso(t(2026, 8, 15, 8, 0)),
  );
});

test("once-style monthly fire, and the next year after an exact hit", () => {
  const p = validateCron("30 14 15 8 *");
  assert.equal(iso(nextFire(p, t(2026, 8, 10))), iso(t(2026, 8, 15, 14, 30)));
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 14, 30, 0))),
    iso(t(2027, 8, 15, 14, 30)),
  );
});

test("leap day: 29 February waits for the leap year", () => {
  const p = validateCron("0 0 29 2 *");
  assert.equal(iso(nextFire(p, t(2026, 1, 1))), iso(t(2028, 2, 29, 0, 0)));
  assert.equal(
    iso(nextFire(p, t(2028, 2, 29, 0, 0, 0))),
    iso(t(2032, 2, 29, 0, 0)),
  );
});

test("impossible day has no next fire (null)", () => {
  assert.equal(nextFire(validateCron("0 0 30 2 *"), t(2026, 1, 1)), null);
});

test("dom/dow union: restricted dom OR restricted dow (vixie rule)", () => {
  // 12:00 on the 13th OR on a Friday. 2026-08-15 is a Saturday.
  const p = validateCron("0 12 13 * 5");
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 0, 0))),
    iso(t(2026, 8, 21, 12, 0)),
  ); // Fri the 21st
  // From exact Thu 13th 12:00, the union's next hit is Fri the 14th (dom did not recur).
  assert.equal(
    iso(nextFire(p, t(2026, 8, 13, 12, 0, 0))),
    iso(t(2026, 8, 14, 12, 0)),
  );
  // A day that matches neither waits for whichever comes next.
  assert.equal(
    iso(nextFire(p, t(2026, 9, 14, 0, 0))),
    iso(t(2026, 9, 18, 12, 0)),
  ); // Fri the 18th
});

test("dom/dow union: a * field does not restrict", () => {
  // dom restricted, dow free -> only dom governs.
  const p = validateCron("0 12 13 * *");
  assert.equal(iso(nextFire(p, t(2026, 8, 15))), iso(t(2026, 9, 13, 12, 0)));
  // dow restricted, dom free -> only dow governs (Friday).
  const q = validateCron("0 12 * * 5");
  assert.equal(iso(nextFire(q, t(2026, 8, 15))), iso(t(2026, 8, 21, 12, 0)));
});

test("every-minute cron fires the next minute boundary", () => {
  const p = validateCron("* * * * *");
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 10, 20, 45))),
    iso(t(2026, 8, 15, 10, 21)),
  );
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 10, 20, 0))),
    iso(t(2026, 8, 15, 10, 21)),
  );
});

test("hour rollover carries into the next day", () => {
  const p = validateCron("0 0 * * *");
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 0, 0, 0))),
    iso(t(2026, 8, 16, 0, 0)),
  ); // strictly after
  assert.equal(
    iso(nextFire(p, t(2026, 8, 15, 23, 59))),
    iso(t(2026, 8, 16, 0, 0)),
  );
});
