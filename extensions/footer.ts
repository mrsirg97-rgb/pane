import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const THINKING_COLORS = new Set([
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
]);

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate?: number;
};

export function collectUsage(entries: any[]): Usage {
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const add = (u: any) => {
    totals.input += u.input ?? 0;
    totals.output += u.output ?? 0;
    totals.cacheRead += u.cacheRead ?? 0;
    totals.cacheWrite += u.cacheWrite ?? 0;
  };
  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.usage) {
      add(entry.message.usage);
      if (entry.message.role === "assistant") {
        const prompt =
          entry.message.usage.input +
          entry.message.usage.cacheRead +
          entry.message.usage.cacheWrite;
        totals.cacheHitRate =
          prompt > 0
            ? (entry.message.usage.cacheRead / prompt) * 100
            : undefined;
      }
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      add(entry.usage);
    }
  }
  return totals;
}

type FooterState = {
  modelId: string;
  reasoning: boolean;
  thinkingLevel: string;
  contextUsage:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  usage: Usage;
  branch: string | null;
  autoCompact: boolean;
  statuses: string[];
};

export function buildFooterLines(
  state: FooterState,
  theme: any,
  width: number,
): string[] {
  const think = state.reasoning
    ? (() => {
        const key = `thinking${state.thinkingLevel[0]?.toUpperCase()}${state.thinkingLevel.slice(1)}`;
        const color = THINKING_COLORS.has(key) ? key : "accent";
        return theme.fg("dim", " · ") + theme.fg(color, state.thinkingLevel);
      })()
    : "";
  const cu = state.contextUsage;
  const window = cu?.contextWindow ?? 0;
  const pct = cu?.percent ?? null;
  const ctxText =
    `${cu?.tokens !== null && cu?.tokens !== undefined ? formatTokens(cu.tokens) : "?"}/${formatTokens(window)}` +
    `${pct !== null ? ` ${pct.toFixed(0)}%` : ""}${state.autoCompact ? " (auto)" : ""}`;
  const ctxPart =
    pct !== null && pct > 90
      ? theme.fg("error", ctxText)
      : pct !== null && pct > 70
        ? theme.fg("warning", ctxText)
        : theme.fg("dim", ctxText);

  let modelLine =
    theme.fg("text", theme.bold(state.modelId)) +
    think +
    theme.fg("dim", " · ") +
    ctxPart;
  const modelWidth = visibleWidth(modelLine);
  if (state.branch && modelWidth + 2 + visibleWidth(state.branch) <= width) {
    modelLine +=
      " ".repeat(width - modelWidth - visibleWidth(state.branch)) +
      theme.fg("dim", state.branch);
  } else if (modelWidth > width) {
    modelLine = truncateToWidth(modelLine, width, "…");
  }

  const parts: string[] = [];
  if (state.usage.input || state.usage.output) {
    parts.push(
      theme.fg(
        "dim",
        `↑${formatTokens(state.usage.input)} ↓${formatTokens(state.usage.output)}`,
      ),
    );
  }
  if (state.usage.cacheRead || state.usage.cacheWrite) {
    const rate =
      state.usage.cacheHitRate !== undefined
        ? ` ${Math.round(state.usage.cacheHitRate)}%`
        : "";
    parts.push(
      theme.fg(
        "dim",
        `⛁ R${formatTokens(state.usage.cacheRead)} W${formatTokens(state.usage.cacheWrite)}${rate}`,
      ),
    );
  }
  const lines = [modelLine];
  if (parts.length) {
    const stats = parts.join(theme.fg("dim", " · "));
    // ⛁ has ambiguous Unicode width: some fonts paint it 2 cells while
    // visibleWidth counts 1. Reserve the difference so the row never clips.
    const reserve = stats.includes("⛁") ? 1 : 0;
    lines.push(truncateToWidth(stats, width - reserve, "…"));
  }
  if (state.statuses.length) {
    lines.push(
      truncateToWidth(theme.fg("dim", state.statuses.join(" ")), width, "…"),
    );
  }
  return lines;
}

function autoCompactFromSettings(): boolean {
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8"),
    );
    return settings.compaction?.enabled !== false;
  } catch {
    return true;
  }
}

export default function footerExtension(pi: ExtensionAPI) {
  const live: { ctx: ExtensionContext | null } = { ctx: null };
  const track = (_event: unknown, ctx: ExtensionContext) => {
    live.ctx = ctx;
  };
  pi.on("model_select", track);
  pi.on("thinking_level_select", track);
  pi.on("turn_start", track);
  pi.on("turn_end", track);
  const autoCompact = autoCompactFromSettings();

  pi.on("session_start", (_event, ctx) => {
    live.ctx = ctx;
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      render(width: number) {
        const current = live.ctx;
        if (!current)
          return [truncateToWidth(theme.fg("dim", "pi"), width, "…")];
        const state: FooterState = {
          modelId: current.model?.id ?? "no-model",
          reasoning: current.model?.reasoning ?? false,
          thinkingLevel: String(current.thinkingLevel ?? "off"),
          contextUsage: current.getContextUsage(),
          usage: collectUsage(current.sessionManager.getEntries() as any[]),
          branch: footerData.getGitBranch(),
          autoCompact,
          statuses: Array.from(footerData.getExtensionStatuses().values()),
        };
        return buildFooterLines(state, theme, width);
      },
      invalidate() {},
    }));
  });
}
