import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXT_DIR, PI_PKG } from "./_test-helpers.mjs";

const SUBTLE = {
  dark: join(EXT_DIR, "..", "themes", "subtle-dark.json"),
  light: join(EXT_DIR, "..", "themes", "subtle-light.json"),
};
const BUILTIN = {
  dark: join(PI_PKG, "dist/modes/interactive/theme/dark.json"),
  light: join(PI_PKG, "dist/modes/interactive/theme/light.json"),
};

const REQUIRED_TOKENS = [
  // core UI (11)
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  // backgrounds & content (11)
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  // markdown (10)
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  // tool diffs (3)
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  // syntax (9)
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  // thinking levels (6)
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  // bash mode (1)
  "bashMode",
];

// Mirror pi's resolveVarRefs: fail closed on unknown or circular refs.
function resolveTheme(path) {
  const theme = JSON.parse(readFileSync(path, "utf8"));
  const vars = theme.vars ?? {};
  const out = {};
  for (const [token, raw] of Object.entries(theme.colors)) {
    out[token] = resolveRef(raw, token);
  }
  return out;

  function resolveRef(value, token, seen = new Set()) {
    if (typeof value === "number" || value === "" || value.startsWith("#"))
      return value;
    if (seen.has(value))
      throw new Error(`${token}: circular var reference ${value}`);
    if (!(value in vars))
      throw new Error(`${token}: unknown var reference ${value}`);
    return resolveRef(vars[value], token, new Set(seen).add(value));
  }
}

function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null; // achromatic: no hue, no family
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function inToolFamily(bg, family, maxDelta = 30) {
  const hue = hexToHue(bg);
  const familyHue = hexToHue(family);
  if (hue === null || familyHue === null) return false;
  const delta = Math.abs(hue - familyHue) % 360;
  return Math.min(delta, 360 - delta) <= maxDelta;
}

for (const variant of ["dark", "light"]) {
  test(`subtle-${variant}: message surfaces wear the tool box color family`, () => {
    const subtle = resolveTheme(SUBTLE[variant]);
    const builtin = resolveTheme(BUILTIN[variant]);
    for (const token of ["customMessageBg", "userMessageBg"]) {
      assert.notEqual(subtle[token], builtin[token], `${token} is still stock`);
      assert.ok(
        inToolFamily(subtle[token], subtle.toolPendingBg),
        `${token} ${subtle[token]} is not in the tool box hue family ` +
          `(${subtle.toolPendingBg})`,
      );
    }
  });

  test(`subtle-${variant}: custom message label follows the accent`, () => {
    const subtle = resolveTheme(SUBTLE[variant]);
    const builtin = resolveTheme(BUILTIN[variant]);
    assert.notEqual(
      subtle.customMessageLabel,
      builtin.customMessageLabel,
      "customMessageLabel is still the stock purple",
    );
    assert.equal(
      subtle.customMessageLabel,
      subtle.accent,
      "customMessageLabel should follow the accent",
    );
  });

  test(`subtle-${variant}: message text stays full contrast`, () => {
    const subtle = resolveTheme(SUBTLE[variant]);
    assert.equal(subtle.customMessageText, subtle.text);
    assert.equal(subtle.userMessageText, subtle.text);
    assert.equal(subtle.toolOutput, subtle.text);
  });

  test(`subtle-${variant}: schema complete, var refs fail closed`, () => {
    const theme = JSON.parse(readFileSync(SUBTLE[variant], "utf8"));
    const missing = REQUIRED_TOKENS.filter((t) => !(t in theme.colors));
    assert.deepEqual(missing, [], `missing required tokens: ${missing}`);
    // resolveTheme already throws on unknown/circular refs; reaching here is the pass.
    assert.ok(resolveTheme(SUBTLE[variant]));
  });
}
