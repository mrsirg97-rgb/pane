import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
import type { Restyle } from "./types/builtin-restyle.types.ts";

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

const LIVE_LINES = 10;

function liveTail(text: string, base: number | null, theme: any): string {
  const lines = text.split("\n");
  const kept = lines.slice(-LIVE_LINES);
  const skipped = lines.length - kept.length;
  const start = base === null ? null : base + skipped;
  const width = start === null ? 0 : String(start + kept.length - 1).length;
  const body = kept
    .map((line, i) => {
      const num =
        start === null
          ? ""
          : theme.fg("dim", String(start + i).padStart(width)) + " ";
      return num + theme.fg("toolDiffContext", line);
    })
    .join("\n");
  return skipped ? `${theme.fg("dim", `… +${skipped} lines`)}\n${body}` : body;
}

function editAnchor(
  state: any,
  cwd: string,
  path: unknown,
  oldText: unknown,
): number | null {
  if (typeof path !== "string" || typeof oldText !== "string" || !oldText)
    return null;
  const key = `${path}\u0000${oldText}`;
  if (state.anchorKey === key) return state.anchor;
  state.anchorKey = key;
  try {
    const file = readFileSync(resolve(cwd, path), "utf8");
    const idx = file.indexOf(oldText);
    state.anchor = idx >= 0 ? file.slice(0, idx).split("\n").length : null;
  } catch {
    state.anchor = null;
  }
  return state.anchor;
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
        const [first] = String(args.command).split("\n");
        return theme.fg("text", `$ ${first}`);
      },
      sub(args, theme) {
        if (!args?.command) return undefined;
        const rest = String(args.command).split("\n").length - 1;
        const parts = [
          rest > 0 && `+${rest} lines`,
          args.timeout && `timeout ${args.timeout}s`,
        ].filter(Boolean);
        return parts.length ? theme.fg("muted", parts.join(" · ")) : undefined;
      },
    },
    {
      def: createReadToolDefinition(cwd, {
        autoResizeImages: s.imageAutoResize,
      }),
      view: { lines: 4, keep: "head" },
      detail(args, theme, c) {
        if (!args?.path) return undefined;
        return theme.fg("text", shortPath(args.path, c));
      },
      sub(args, theme) {
        const range = [
          args?.offset !== undefined && `from ${args.offset}`,
          args?.limit !== undefined && `${args.limit} lines`,
        ]
          .filter(Boolean)
          .join(" · ");
        return range ? theme.fg("muted", range) : undefined;
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
      live(args) {
        if (typeof args?.content !== "string" || !args.content)
          return undefined;
        return { text: args.content, base: 1 };
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
      live(args, state, cwd) {
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        const last = edits[edits.length - 1];
        if (typeof last?.newText !== "string" || !last.newText)
          return undefined;
        return {
          text: last.newText,
          base: editAnchor(state, cwd, args?.path, last.oldText),
        };
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
      detail(args, theme) {
        if (!args?.pattern) return undefined;
        return theme.fg("text", args.pattern);
      },
      sub(args, theme, c) {
        const where = [shortPath(args?.path, c), args?.glob]
          .filter(Boolean)
          .join(" ");
        return where ? theme.fg("muted", `in ${where}`) : undefined;
      },
    },
    {
      def: createFindToolDefinition(cwd),
      view: { lines: 6, keep: "head" },
      detail(args, theme) {
        if (!args?.pattern) return undefined;
        return theme.fg("text", args.pattern);
      },
      sub(args, theme, c) {
        return args?.path
          ? theme.fg("muted", `in ${shortPath(args.path, c)}`)
          : undefined;
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
        const spec =
          !ctx.executionStarted && live
            ? live(args, ctx.state, ctx.cwd)
            : undefined;
        const subText = spec ? undefined : sub?.(args, theme, ctx.cwd);
        if (subText) rows.push(new Text(indent(subText), 0, 0));
        if (spec) {
          // memoized per call: restyle only when the streamed text grows
          const st = ctx.state;
          if (st.liveText !== spec.text || st.liveBase !== spec.base) {
            st.liveText = spec.text;
            st.liveBase = spec.base;
            st.liveOut = liveTail(spec.text, spec.base, theme);
          }
          rows.push(new Text(indent(st.liveOut), 0, 0));
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
