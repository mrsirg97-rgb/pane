// compact-guard: per-model compaction gating on top of pi's global trigger.
//
// pi fires session_before_compact before auto-compaction when
// contextTokens > contextWindow - compaction.reserveTokens, one global
// number, and honours { cancel: true } from a handler. pi's global
// reserve is now a floor, not the policy: it is set to 16384 in
// ~/.pi/agent/settings.json so pi's trigger fires early enough for the
// smallest model (its derived reserve is 14746), and this table decides
// the per-model boundary. The guard can only delay compaction, never
// bring it forward: pi must still fire first.
//
// The rows are pane's side of rig's models table (~/Projects/rig
// models/models.go, SPEC_COMPACT 2): windows and the 64k row's maxTokens
// mirror models.Defaults row for row. Rig hardcodes Reserve; here it is
// derived as maxTokens + 0.1*window, with a per-row override allowed.
//
// The token count to compare comes off the event: preparation.tokensBefore
// is pi's own estimate of current context (CompactionPreparation.tokensBefore,
// computed by prepareCompaction). No sessionManager read needed.
//
// Only the auto-threshold path is guarded. manual /compact is user intent
// and overflow recovery is already past the window; both pass untouched.
// Unknown models pass untouched too: pi's own math stands.
//
// The pi-bug shape (a global reserve larger than a model's window firing
// compaction on every estimate, seen 2026-08-15 at 81216 > 65536) is
// unreachable while GLOBAL_RESERVE < every row's window; the tests pin it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ModelRow {
  window: number;
  maxTokens: number;
  /** explicit reserve; beats the derived one */
  reserve?: number;
}

/**
 * Per-model rows, keyed by pi model id (model.id in ctx and the registry).
 * Windows from ~/.pi/agent/models.json; maxTokens per the rig table.
 */
export const MODEL_ROWS: Record<string, ModelRow> = {
  deepriver: { window: 393_216, maxTokens: 65_536 },
  huihui0731: { window: 393_216, maxTokens: 65_536 },
  "huihui3.8": { window: 262_144, maxTokens: 32_768 },
  "qwen3.8-workers": { window: 65_536, maxTokens: 8_192 },
};

/** pi's global compaction.reserveTokens, the floor. Keep in sync with settings.json. */
export const GLOBAL_RESERVE = 16_384;

export function reserveOf(row: ModelRow): number {
  return row.reserve ?? Math.round(row.maxTokens + 0.1 * row.window);
}

/** The model's own compaction trigger: compact only past this. */
export function triggerOf(row: ModelRow): number {
  return row.window - reserveOf(row);
}

export interface Decision {
  cancel: boolean;
  trigger: number;
  reserve: number;
}

/**
 * The guard's verdict for one model at one token count.
 * Cancel unless the model's own trigger is past (strict >, pi's and
 * rig's boundary: exactly at the trigger does not compact).
 */
export function decide(row: ModelRow, tokensBefore: number): Decision {
  const reserve = reserveOf(row);
  const trigger = row.window - reserve;
  return { cancel: tokensBefore <= trigger, trigger, reserve };
}

function logLine(
  ctx: { hasUI: boolean; ui: { notify: (m: string) => void } },
  line: string,
) {
  const msg = `[compact-guard] ${line}`;
  if (ctx.hasUI) {
    ctx.ui.notify(msg, "info");
  } else {
    console.log(msg);
  }
}

export default function compactGuardExtension(pi: ExtensionAPI) {
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason !== "threshold") return undefined;
    const id = ctx.model?.id;
    const row = id ? MODEL_ROWS[id] : undefined;
    if (!row) return undefined;
    const tokens = event.preparation?.tokensBefore ?? 0;
    const d = decide(row, tokens);
    logLine(
      ctx,
      `${id}: ${d.cancel ? "cancel" : "proceed"} (${tokens} ${d.cancel ? "<=" : ">"} trigger ${d.trigger}, reserve ${d.reserve})`,
    );
    return d.cancel ? { cancel: true } : undefined;
  });
}
