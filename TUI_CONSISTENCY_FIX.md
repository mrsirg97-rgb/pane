# TUI consistency fix

## Problem

`/compact` (and every other surface pane does not re-render) wears the stock pi
theme colors. Verified against the installed pi: `subtle-dark.json` /
`subtle-light.json` resolve to the built-in `dark` / `light` on 47 of 53 tokens.
The message surfaces are the loudest stock tell: the compaction / branch /
skill / custom-message boxes wear the stock purple-tinted `customMessageBg`
(`#2d2838` / `#ede7f6`) with a stock purple `customMessageLabel`
(`#9575cd` / `#7e57c2`), and user messages wear the stock `userMessageBg`
(`#343541` / `#e8e8e8`). Meanwhile the six tokens pane actually customized
(`toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolOutput`, `mdCodeBlock`,
`mdCodeBlockBorder`) land exactly where the restyled tools already cover, so
the "pane look" stops at the tool chrome.

Tool coverage is complete (all seven builtin tools restyled, every renderer
token defined in both themes), so this is a palette fix, not a renderer fix.
Core component layouts are not reachable from the Extension API; they keep pi's
shape and only get pane colors.

## Scope (agreed)

Update the message-surface tokens to match the tool boxes, in both variants:

- `customMessageBg` and `userMessageBg` move into the cool blue-gray family of
  `toolPendingBg` (the family the tool chrome already wears).
- `customMessageLabel` follows the accent instead of the stock purple: the
  label is the title slot of the box, and pane titles carry the accent.
- `customMessageText` / `userMessageText` stay `text`: full contrast, same as
  `toolOutput`.
- Everything else stays untouched (no full palette re-derivation this round).

Values (dark / light): `customMessageBg` `#202536` / `#edf1f9`, `userMessageBg`
`#262c3c` / `#e6ebf2`, `customMessageLabel` `accent` / `accent`. Dark values
revised in review: the first cut matched hue but ran chroma spread 28 vs the
tool family's 21, reading as a blue box; prominence now comes from lightness
at matched chroma (spread 22, avg 36 -> 41 -> 47), enforced by a chroma test. User message
boxes stay one step more prominent than custom-message boxes, mirroring the
stock ordering.

## Design

**A. Hue-family invariant, not value equality.** The test does not assert the
exact hex values; it asserts the property "matches the tools": each message
background's hue is within 30 degrees of the same variant's `toolPendingBg`
hue, and it differs from the built-in value. A neutral (achromatic) value has
no hue and can never satisfy the family check. Exact shades stay tunable by
the user without touching the test.

**B. Label follows the accent by reference, not by copy.** The JSON sets
`"customMessageLabel": "accent"` (a var-style reference to the token), so the
label can never drift from the accent the status glyphs already use.

**C. Fail-closed resolution in the test.** The test resolves var references
exactly like pi's `resolveVarRefs` (cycle detection, unknown var ref throws),
and asserts all 51 required tokens are present: a theme that fails pi's schema
validation silently falls back to the built-in `dark` theme, which would
defeat the fix.

**D. Deployment.** `pane-setup` copies themes only-if-absent and pi hot-reloads
`~/.pi/agent/themes/`, so shipping this fix overwrites the two deployed copies
(direct write, no delete) and the running session picks it up on reload.

## Non-goals

- No full palette re-derivation (warning yellow, thinking ladder, syntax
  family stay stock this round; revisit if the message surfaces prove the
  approach).
- No renderer changes, no pi fork or patch.

## TDD test plan

File: `extensions/__tests__/theme-consistency.test.mjs` (pure file reads;
builtin paths resolved through the installed pi package via `PI_PKG` from
`_test-helpers.mjs`). Per variant (dark, light):

1. **Message surfaces in the tool family (red before, green after).**
   `customMessageBg` / `userMessageBg` differ from the builtin and sit within
   30 degrees of `toolPendingBg`'s hue.
2. **Label follows the accent (red before, green after).** Label differs from
   the builtin purple and equals the resolved `accent`.
3. **Contrast and token guards (green before and after).** `customMessageText`
   / `userMessageText` / `toolOutput` all resolve to `text`.
4. **Schema completeness (green before and after).** All 51 required tokens
   present, var refs resolve without cycles (fail closed).

Then the two theme JSONs get the new values, full `npm test` green, deployed
copies overwritten.


## Revision 2 (final): flat surfaces

Design pivot after seeing rev 1 live: message surfaces drop their backgrounds
entirely. pane is flat wherever the tools are flat; boxed user/compaction
messages were the last washes standing. `userMessageBg` / `customMessageBg`
are now `""` — pi's sanctioned transparent (`bgAnsi("")` emits ESC[49m, the
terminal default background). Labels keep the accent, text keeps full
contrast. The family/chroma work above remains as the record of how we got
here; the shipped invariant is flatness (tested), not family membership.
