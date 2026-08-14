import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { errorText, header, indent, preview, stack } from "./_render-kit.mjs";

const HOME = homedir();

function piSettings(): Record<string, any> {
  try {
    return JSON.parse(
      readFileSync(join(HOME, ".pi/agent/settings.json"), "utf8"),
    );
  } catch {
    return {};
  }
}

export function shortPath(path: string | undefined, cwd: string): string {
  if (!path) return "";
  let out = path;
  if (cwd && out.startsWith(cwd + "/")) out = out.slice(cwd.length + 1);
  else if (out === cwd) out = ".";
  else if (out.startsWith(HOME)) out = "~" + out.slice(HOME.length);
  if (out.length > 44) out = `${out.slice(0, 20)}…${out.slice(-23)}`;
  return out;
}

/** Line-colored diff via the passed theme; the built-in renderDiff needs the
 *  interactive theme singleton, which only exists inside a live TUI. */
export function styleDiff(diff: string, theme: any): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

function resultText(result: any): string {
  return ((result.content ?? []) as any[])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trimEnd();
}

function body(
  theme: any,
  ctx: any,
  result: any,
  opts: { lines: number; keep: "head" | "tail" },
  override?: string,
) {
  if (result.isError) return errorText(theme, result);
  const styled =
    override ??
    resultText(result)
      .split("\n")
      .map((line: string) => theme.fg("toolOutput", line))
      .join("\n");
  return preview(theme, ctx, styled, opts);
}

type Restyle = {
  def: any;
  detail: (args: any, theme: any, cwd: string) => string | undefined;
  view: { lines: number; keep: "head" | "tail" };
  timed?: boolean;
  body?: (args: any, result: any, theme: any) => string | undefined;
  /** Counter row rendered under the header (own line, never wraps the path). */
  sub?: (args: any, theme: any) => string | undefined;
  /** Streaming preview while the call's args are still arriving. */
  live?: (args: any, theme: any) => string | undefined;
};

const LIVE_LINES = 10;

/** Tail of streaming text, styled as tool output with a dim skip marker. */
function liveTail(text: unknown, theme: any): string | undefined {
  if (typeof text !== "string" || !text) return undefined;
  const lines = text.split("\n");
  const kept = lines.slice(-LIVE_LINES);
  const skipped = lines.length - kept.length;
  const body = kept.map((line) => theme.fg("toolOutput", line)).join("\n");
  return skipped ? `${theme.fg("dim", `… +${skipped} lines`)}\n${body}` : body;
}

function restyles(cwd: string, s: Record<string, any>): Restyle[] {
  const pathDetail = (args: any, theme: any, c: string) =>
    args?.path !== undefined || args
      ? theme.fg("text", shortPath(args?.path, c) || ".")
      : undefined;
  return [
    {
      def: createBashToolDefinition(cwd, {
        commandPrefix: s.shellCommandPrefix,
        shellPath: s.shellPath,
      }),
      timed: true,
      view: { lines: 6, keep: "tail" },
      detail(args, theme) {
        if (!args?.command) return undefined;
        const [first, ...rest] = String(args.command).split("\n");
        return (
          theme.fg("text", `$ ${first}`) +
          (rest.length ? theme.fg("muted", ` +${rest.length} lines`) : "") +
          (args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "")
        );
      },
    },
    {
      def: createReadToolDefinition(cwd, {
        autoResizeImages: s.imageAutoResize,
      }),
      view: { lines: 4, keep: "head" },
      detail(args, theme, c) {
        if (!args?.path) return undefined;
        const range = [
          args.offset !== undefined && `from ${args.offset}`,
          args.limit !== undefined && `${args.limit} lines`,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          theme.fg("text", shortPath(args.path, c)) +
          (range ? theme.fg("muted", ` (${range})`) : "")
        );
      },
    },
    {
      def: createWriteToolDefinition(cwd),
      view: { lines: 15, keep: "head" },
      detail(args, theme, c) {
        if (!args?.path) return undefined;
        return theme.fg("text", shortPath(args.path, c));
      },
      sub(args, theme) {
        if (typeof args?.content !== "string" || !args.content)
          return undefined;
        return theme.fg("muted", `${args.content.split("\n").length} lines`);
      },
      live(args, theme) {
        return liveTail(args?.content, theme);
      },
      body(args, _result, theme) {
        if (typeof args?.content !== "string" || !args.content.trim())
          return undefined;
        return args.content
          .split("\n")
          .map((line: string) => theme.fg("toolOutput", line))
          .join("\n");
      },
    },
    {
      def: createEditToolDefinition(cwd),
      view: { lines: 15, keep: "head" },
      detail(args, theme, c) {
        if (!args?.path) return undefined;
        return theme.fg("text", shortPath(args.path, c));
      },
      sub(args, theme) {
        const n = Array.isArray(args?.edits) ? args.edits.length : 0;
        return n
          ? theme.fg("muted", `${n} edit${n === 1 ? "" : "s"}`)
          : undefined;
      },
      live(args, theme) {
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        return liveTail(edits[edits.length - 1]?.newText, theme);
      },
      body(_args, result, theme) {
        const diff = result?.details?.diff;
        return typeof diff === "string" && diff
          ? styleDiff(diff, theme)
          : undefined;
      },
    },
    {
      def: createGrepToolDefinition(cwd),
      view: { lines: 6, keep: "head" },
      detail(args, theme, c) {
        if (!args?.pattern) return undefined;
        const where = [shortPath(args.path, c), args.glob]
          .filter(Boolean)
          .join(" ");
        return (
          theme.fg("text", args.pattern) +
          (where ? theme.fg("muted", ` in ${where}`) : "")
        );
      },
    },
    {
      def: createFindToolDefinition(cwd),
      view: { lines: 6, keep: "head" },
      detail(args, theme, c) {
        if (!args?.pattern) return undefined;
        return (
          theme.fg("text", args.pattern) +
          (args.path ? theme.fg("muted", ` in ${shortPath(args.path, c)}`) : "")
        );
      },
    },
    {
      def: createLsToolDefinition(cwd),
      view: { lines: 6, keep: "head" },
      detail: pathDetail,
    },
  ];
}

export default function builtinRestyleExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const s = piSettings();
  for (const { def, detail, view, timed, body: bodyFn, sub, live } of restyles(
    cwd,
    s,
  )) {
    pi.registerTool({
      ...def,
      renderShell: "self",
      renderCall(args: any, theme: any, ctx: any) {
        if (timed && ctx.executionStarted && ctx.state.startedAt === undefined)
          ctx.state.startedAt = Date.now();
        ctx.state.args = args;
        const head = header(theme, ctx, def.name, detail(args, theme, ctx.cwd));
        const rows: any[] = [head];
        const subText = sub?.(args, theme);
        if (subText) rows.push(new Text(indent(subText), 0, 0));
        if (!ctx.executionStarted && live) {
          const streaming = live(args, theme);
          if (streaming) rows.push(new Text(indent(streaming), 0, 0));
        }
        return rows.length > 1 ? stack(...rows) : head;
      },
      renderResult(result: any, options: any, theme: any, ctx: any) {
        if (
          timed &&
          !options.isPartial &&
          ctx.state.startedAt !== undefined &&
          ctx.state.endedAt === undefined
        ) {
          ctx.state.endedAt = Date.now();
        }
        const output = body(
          theme,
          ctx,
          result,
          view,
          bodyFn?.(ctx.state.args, result, theme),
        );
        if (!timed || ctx.state.startedAt === undefined) return output;
        const ms = (ctx.state.endedAt ?? Date.now()) - ctx.state.startedAt;
        return stack(
          output,
          new Text(indent(theme.fg("dim", `${(ms / 1000).toFixed(1)}s`)), 0, 0),
        );
      },
    });
  }
}
