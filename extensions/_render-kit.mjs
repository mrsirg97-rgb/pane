// Shared flat rendering kit for the local extensions. Discovery ignores .mjs,
// so this stays a library, never an extension.
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";

const GLYPH = { pending: "○", running: "◐", ok: "●", fail: "✕" };
const COLOR = { pending: "dim", running: "accent", ok: "success", fail: "error" };

export function status(ctx) {
  if (!ctx.executionStarted) return "pending";
  if (ctx.isPartial) return "running";
  return ctx.isError ? "fail" : "ok";
}

export function statusGlyph(theme, ctx) {
  const s = status(ctx);
  return theme.fg(COLOR[s], GLYPH[s]);
}

export function header(theme, ctx, name, styledDetail) {
  const title = theme.fg("toolTitle", theme.bold(name));
  const suffix = styledDetail ? `${theme.fg("dim", " · ")}${styledDetail}` : "";
  return new Text(`${statusGlyph(theme, ctx)} ${title}${suffix}`, 0, 0);
}

export function indent(text, pad = "  ") {
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

export function shortUrl(url, max = 44) {
  const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (bare.length <= max) return bare;
  const head = Math.ceil((max - 1) * 0.6);
  return `${bare.slice(0, head)}…${bare.slice(-(max - 1 - head))}`;
}

export function errorText(theme, result) {
  const message = (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  return new Text(indent(theme.fg("error", message || "failed")), 0, 0);
}

/** Collapsed width-aware preview. keep: "head" shows the first lines (hint after),
 *  "tail" the last ones (hint before, matching the built-in bash renderer). */
export function preview(theme, ctx, styledText, { lines = 6, keep = "head" } = {}) {
  if (!styledText.trim()) return new Text(indent(theme.fg("dim", "(no output)")), 0, 0);
  if (ctx.expanded) return new Text(indent(styledText), 0, 0);
  const cache = {};
  return {
    render(width) {
      if (cache.width !== width) {
        const all = new Text(indent(styledText), 0, 0).render(width);
        cache.skipped = Math.max(0, all.length - lines);
        cache.kept = keep === "head" ? all.slice(0, lines) : all.slice(-lines);
        cache.width = width;
      }
      if (!cache.skipped) return cache.kept;
      let expandHint;
      try {
        expandHint = keyHint("app.tools.expand", "to expand");
      } catch {
        expandHint = theme.fg("muted", "ctrl+o to expand");
      }
      const hint = truncateToWidth(
        `  ${theme.fg("dim", `… +${cache.skipped} lines`)} ${expandHint}`,
        width,
        "…",
      );
      return keep === "head" ? [...cache.kept, hint] : [hint, ...cache.kept];
    },
    invalidate() {
      cache.width = undefined;
    },
  };
}

export function stack(...components) {
  const children = components.filter(Boolean);
  return {
    render: (width) => children.flatMap((c) => c.render(width)),
    invalidate: () => children.forEach((c) => c.invalidate?.()),
  };
}

export function progressBar(theme, done, total, segments = 8) {
  const filled = total ? Math.round((done / total) * segments) : 0;
  return theme.fg("accent", "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(segments - filled));
}
