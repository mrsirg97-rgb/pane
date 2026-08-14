import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadExtensionTool, EXT_DIR } from "./_test-helpers.mjs";

async function runSetupWithHome(home) {
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await loadExtensionTool(join(EXT_DIR, "pane-setup.ts"), {
      requireTool: false,
    });
  } finally {
    process.env.HOME = realHome;
  }
}

test("themes are copied into a fresh agent dir", async () => {
  const home = mkdtempSync(join(tmpdir(), "pane-setup-"));
  await runSetupWithHome(home);
  const copied = readdirSync(join(home, ".pi/agent/themes")).sort();
  const shipped = readdirSync(join(EXT_DIR, "../themes"))
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert.deepEqual(copied, shipped);
});

test("existing theme files are never overwritten", async () => {
  const home = mkdtempSync(join(tmpdir(), "pane-setup-"));
  const themesDir = join(home, ".pi/agent/themes");
  mkdirSync(themesDir, { recursive: true });
  writeFileSync(join(themesDir, "subtle-dark.json"), '{"user":"customized"}');
  await runSetupWithHome(home);
  assert.equal(
    readFileSync(join(themesDir, "subtle-dark.json"), "utf8"),
    '{"user":"customized"}',
  );
  assert.equal(existsSync(join(themesDir, "subtle-light.json")), true);
});

test("kernel host resolves to the agent dir override, else the package copy", async () => {
  const { exports: ext } = await loadExtensionTool(
    join(EXT_DIR, "python-kernel.ts"),
    { requireTool: false },
  );
  const resolved = ext.resolveKernelHost();
  const agentCopy = join(homedir(), ".pi/agent/kernel/kernel_host.py");
  if (existsSync(agentCopy)) {
    assert.equal(resolved, agentCopy);
  } else {
    assert.equal(resolved, join(EXT_DIR, "../kernel/kernel_host.py"));
  }
  assert.equal(existsSync(resolved), true, "resolved kernel host exists");
});

test("ensureKernel is a no-op when the venv already exists", async () => {
  const { exports: ext } = await loadExtensionTool(
    join(EXT_DIR, "python-kernel.ts"),
    { requireTool: false },
  );
  if (!existsSync(ext.KERNEL_PYTHON)) return;
  const started = Date.now();
  await ext.ensureKernel();
  assert.ok(Date.now() - started < 100, "no bootstrap work when venv present");
});

test("contract is seeded into a fresh agent dir", async () => {
  const home = mkdtempSync(join(tmpdir(), "pane-setup-"));
  await runSetupWithHome(home);
  const seeded = join(home, ".pi/agent/AGENTS.md");
  assert.equal(existsSync(seeded), true);
  assert.match(readFileSync(seeded, "utf8"), /agent contract/);
});

test("an existing contract is never overwritten", async () => {
  const home = mkdtempSync(join(tmpdir(), "pane-setup-"));
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  writeFileSync(join(home, ".pi/agent/AGENTS.md"), "# my own contract");
  await runSetupWithHome(home);
  assert.equal(readFileSync(join(home, ".pi/agent/AGENTS.md"), "utf8"), "# my own contract");
});
