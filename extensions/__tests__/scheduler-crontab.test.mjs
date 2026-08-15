import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_DIR, loadExtension, scratchDir } from "./_test-helpers.mjs";

const {
  lineFor,
  scan,
  upsertLine,
  setPaused,
  removeLine,
  normalize,
  realCrontabShim,
} = await loadExtension(join(EXT_DIR, "scheduler/crontab.ts"));

const RUNNER = "/home/u/.pi/agent/scheduler/runner.sh";

// A crontab full of foreign lines that must survive byte-identical.
const FOREIGN = [
  "# foreign comment at top",
  "SHELL=/bin/bash",
  'MAILTO=""',
  "0 5 * * * /usr/local/bin/backup.sh   # user's own trailing comment",
  "15 3 * * 0  /opt/tool --weekly",
  "",
  "# a note mentioning pane-scheduler in prose",
  "30 6 * * * echo hi # pane-scheduler:NOTOURS  # tag not trailing",
].join("\n");

test("lineFor builds the exact tagged format", () => {
  assert.equal(
    lineFor("j1", "0 */4 * * *", RUNNER),
    `0 */4 * * * ${RUNNER} j1  # pane-scheduler:j1`,
  );
  assert.equal(
    lineFor("cwd-abc123def456:j2", "5 4 * * *", RUNNER),
    `5 4 * * * ${RUNNER} cwd-abc123def456:j2  # pane-scheduler:cwd-abc123def456:j2`,
  );
});

test("upsert appends a tagged line; every foreign line survives byte-identical", () => {
  const { text, added } = upsertLine(FOREIGN, "j1", "0 */4 * * *", RUNNER);
  assert.equal(added, true);
  const lines = text.trimEnd().split("\n");
  // foreign lines, in order, byte-identical, prefix of the result
  for (let i = 0; i < FOREIGN.split("\n").length; i++) {
    assert.equal(lines[i], FOREIGN.split("\n")[i]);
  }
  assert.equal(lines.at(-1), `0 */4 * * * ${RUNNER} j1  # pane-scheduler:j1`);
  assert.equal(text.endsWith(`${lines.at(-1)}\n`), true); // one trailing newline
});

test("upsert on an empty crontab yields exactly one line", () => {
  const { text, added } = upsertLine("", "j1", "0 0 * * *", RUNNER);
  assert.equal(added, true);
  assert.equal(text, `0 0 * * * ${RUNNER} j1  # pane-scheduler:j1\n`);
});

test("upsert replaces an existing key in place (no duplicate, position kept)", () => {
  const seeded = FOREIGN + `\n0 0 * * * ${RUNNER} j9  # pane-scheduler:j9\n`;
  const { text, added } = upsertLine(seeded, "j9", "30 1 * * *", RUNNER);
  assert.equal(added, false);
  const found = text.split("\n").filter((l) => l.includes("pane-scheduler:j9"));
  assert.equal(found.length, 1);
  assert.equal(found[0], `30 1 * * * ${RUNNER} j9  # pane-scheduler:j9`);
  // still in its original position (after the foreign block, before any later tag)
  const idx = text.split("\n").indexOf(found[0]);
  assert.equal(idx, FOREIGN.split("\n").length);
});

test("setPaused comments the line; tag stays discoverable; foreign untouched", () => {
  const seeded = FOREIGN + `\n0 0 * * * ${RUNNER} j1  # pane-scheduler:j1\n`;
  const { text, found } = setPaused(seeded, "j1", true);
  assert.equal(found, true);
  const lines = text.trimEnd().split("\n");
  for (let i = 0; i < FOREIGN.split("\n").length; i++)
    assert.equal(lines[i], FOREIGN.split("\n")[i]);
  assert.equal(lines.at(-1), `# 0 0 * * * ${RUNNER} j1  # pane-scheduler:j1`);
  const scanned = scan(text);
  const j1 = scanned.find((l) => l.key === "j1");
  assert.equal(j1.paused, true);
  assert.equal(j1.cron, "0 0 * * *");
});

test("setPaused is idempotent (already paused -> unchanged)", () => {
  const paused = FOREIGN + `\n# 0 0 * * * ${RUNNER} j1  # pane-scheduler:j1\n`;
  const { text, found } = setPaused(paused, "j1", true);
  assert.equal(found, true);
  assert.equal(text, paused);
});

test("setPaused of a missing key reports found=false and changes nothing", () => {
  const { text, found } = setPaused(FOREIGN, "j404", true);
  assert.equal(found, false);
  assert.equal(text, FOREIGN + "\n"); // normalize adds the trailing newline only
});

test("resume strips exactly the '# ' prefix -> byte-identical to the active line", () => {
  const active = `0 0 * * * ${RUNNER} j1  # pane-scheduler:j1`;
  const paused = FOREIGN + `\n# ${active}\n`;
  const { text, found } = setPaused(paused, "j1", false);
  assert.equal(found, true);
  assert.equal(text.trimEnd().split("\n").at(-1), active);
});

test("remove deletes the line (active or paused) and leaves no trace", () => {
  const active = FOREIGN + `\n0 0 * * * ${RUNNER} j1  # pane-scheduler:j1\n`;
  let r = removeLine(active, "j1");
  assert.equal(r.found, true);
  assert.equal(r.text, FOREIGN + "\n");
  assert.ok(!r.text.includes("pane-scheduler:j1"));

  const paused = FOREIGN + `\n# 0 0 * * * ${RUNNER} j1  # pane-scheduler:j1\n`;
  r = removeLine(paused, "j1");
  assert.equal(r.found, true);
  assert.equal(r.text, FOREIGN + "\n");
});

test("remove of a missing key reports found=false", () => {
  const r = removeLine(FOREIGN, "j404");
  assert.equal(r.found, false);
});

test("scan finds tagged lines (active + paused) and extracts cron fields", () => {
  const text =
    FOREIGN +
    `\n0 */4 * * * ${RUNNER} j1  # pane-scheduler:j1\n` +
    `# 5 4 * * * ${RUNNER} cwd-abc123def456:j2  # pane-scheduler:cwd-abc123def456:j2\n`;
  const found = scan(text);
  const j1 = found.find((l) => l.key === "j1");
  const j2 = found.find((l) => l.key === "cwd-abc123def456:j2");
  assert.equal(j1.paused, false);
  assert.equal(j1.cron, "0 */4 * * *");
  assert.equal(j2.paused, true);
  assert.equal(j2.cron, "5 4 * * *");
});

test("scan ignores lookalikes: prose comments, non-trailing tags, standalone tags", () => {
  const text = [
    "# prose about pane-scheduler and friends",
    "30 6 * * * echo hi # pane-scheduler:NOTOURS  # tag not trailing",
    "# pane-scheduler:standalone",
    `0 0 * * * ${RUNNER} j1  # pane-scheduler:j1`,
  ].join("\n");
  const found = scan(text);
  assert.deepEqual(
    found.map((l) => l.key),
    ["j1"],
  );
});

test("normalize: exactly one trailing newline, no double, empty stays empty", () => {
  assert.equal(normalize(""), "");
  assert.equal(normalize("a\n"), "a\n");
  assert.equal(normalize("a"), "a\n");
  assert.equal(normalize("a\n\n\n"), "a\n");
});

// ---- real shim: against a fake crontab binary on a temp spool (no live crontab) ----

test("shim: absent spool (exit 1 + 'no crontab for') reads as empty; round-trip works", async () => {
  const dir = scratchDir();
  const spool = join(dir, "spool");
  const bin = join(dir, "crontab");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "-l" ]; then\n  if [ -f "$SPOOL" ]; then cat "$SPOOL"; else echo "crontab: no crontab for test" >&2; exit 1; fi\nelse\n  mkdir -p "$(dirname "$SPOOL")"; cat > "$SPOOL"\nfi\n`,
  );
  chmodSync(bin, 0o755);
  const prev = process.env.SPOOL;
  process.env.SPOOL = spool;
  try {
    const shim = realCrontabShim(bin);
    assert.equal(await shim.list(), ""); // absent spool: like "no crontab for user"
    await shim.install("0 0 * * * /bin/true\n");
    assert.equal(await shim.list(), "0 0 * * * /bin/true\n");
  } finally {
    if (prev === undefined) delete process.env.SPOOL;
    else process.env.SPOOL = prev;
  }
});

test("shim: exit 1 with unexpected stderr refuses loudly (never a false empty)", async () => {
  const dir = scratchDir();
  const bin = join(dir, "crontab");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "PAM: user not authorized" >&2\nexit 1\n`,
  );
  chmodSync(bin, 0o755);
  const shim = realCrontabShim(bin);
  await assert.rejects(
    () => shim.list(),
    /crontab list failed.*PAM: user not authorized/s,
  );
});

test("shim: missing binary refuses loudly (list and install)", async () => {
  const shim = realCrontabShim("/nonexistent/no-such-crontab");
  await assert.rejects(() => shim.list(), /binary not found/);
  await assert.rejects(() => shim.install("x"), /binary not found/);
});
