// Test harness for pi extensions, mirroring the real loader:
// jiti with the same aliases pi uses (see dist/core/extensions/loader.js).
// .mjs files are ignored by pi's *.ts auto-discovery, so co-location is inert.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export const EXT_DIR = dirname(fileURLToPath(import.meta.url));

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
export const PI_PKG = join(npmRoot, "@earendil-works", "pi-coding-agent");
const require = createRequire(join(PI_PKG, "package.json"));

const typebox = require.resolve("typebox");
const typeboxCompile = require.resolve("typebox/compile");
const typeboxValue = require.resolve("typebox/value");

const ALIAS = {
  typebox,
  "typebox/compile": typeboxCompile,
  "typebox/value": typeboxValue,
  "@sinclair/typebox": typebox,
  "@sinclair/typebox/compile": typeboxCompile,
  "@sinclair/typebox/value": typeboxValue,
  "@earendil-works/pi-ai": join(PI_PKG, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(PI_PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  "@earendil-works/pi-coding-agent": join(PI_PKG, "dist/index.js"),
};

/** Load an extension module; returns { default: factory, ...exports }. */
export async function loadExtension(extPath) {
  const jitiMod = await import(pathToFileURL(join(PI_PKG, "node_modules/jiti/lib/jiti-static.mjs")).href);
  const jiti = jitiMod.createJiti(import.meta.url, { moduleCache: false, alias: ALIAS });
  return jiti.import(extPath);
}

/** Load an extension and capture its registered tool + event handlers.
 *  Pass { requireTool: false } for extensions that only register events. */
export async function loadExtensionTool(extPath, { requireTool = true } = {}) {
  const mod = await loadExtension(extPath);
  const factory = typeof mod.default === "function" ? mod.default : mod;
  let tool = null;
  const tools = new Map();
  const handlers = {};
  await factory({
    registerTool(def) {
      tool = def;
      tools.set(def.name, def);
    },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    on(event, fn) {
      handlers[event] = fn;
    },
  });
  if (requireTool && !tool) throw new Error(`extension ${extPath} did not register a tool`);
  return { tool, tools, handlers, exports: mod };
}

/** An isolated scratch directory for a test (also used as cwd/HOME). */
export function scratchDir() {
  // realpath: macOS tmpdir lives under /var -> /private/var symlink, and
  // process.cwd() always returns the resolved spelling.
  return realpathSync(mkdtempSync(join(tmpdir(), "pi-ext-test-")));
}

/** TypeBox Value from pi's bundled copy (same code the extension schema uses). */
export async function typeboxValueModule() {
  return import(pathToFileURL(require.resolve("typebox/value")).href);
}

export function textOf(result) {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
