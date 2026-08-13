import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { errorText, header, indent, preview, stack } from "./_render-kit.mjs";

const HOME = homedir();

// The session builds its base tools from these settings; the overrides must pass
// the same ones through or execution would silently diverge from stock pi.
function piSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(HOME, ".pi/agent/settings.json"), "utf8"));
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

function resultText(result: any): string {
  return ((result.content ?? []) as any[])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trimEnd();
}

function body(theme: any, ctx: any, result: any, opts: { lines: number; keep: "head" | "tail" }) {
  if (result.isError) return errorText(theme, result);
  const styled = resultText(result)
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
};

function restyles(cwd: string, s: Record<string, any>): Restyle[] {
  const pathDetail = (args: any, theme: any, c: string) =>
    args?.path !== undefined || args ? theme.fg("text", shortPath(args?.path, c) || ".") : undefined;
  return [
    {
      def: createBashToolDefinition(cwd, { commandPrefix: s.shellCommandPrefix, shellPath: s.shellPath }),
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
      def: createReadToolDefinition(cwd, { autoResizeImages: s.imageAutoResize }),
      view: { lines: 4, keep: "head" },
      detail(args, theme, c) {
        if (!args?.path) return undefined;
        const range = [args.offset !== undefined && `from ${args.offset}`, args.limit !== undefined && `${args.limit} lines`]
          .filter(Boolean)
          .join(" · ");
        return theme.fg("text", shortPath(args.path, c)) + (range ? theme.fg("muted", ` (${range})`) : "");
      },
    },
    {
      def: createWriteToolDefinition(cwd),
      view: { lines: 3, keep: "head" },
      detail(args, theme, c) {
        if (!args?.path) return undefined;
        const lines = typeof args.content === "string" ? args.content.split("\n").length : undefined;
        return theme.fg("text", shortPath(args.path, c)) + (lines ? theme.fg("muted", ` ${lines} lines`) : "");
      },
    },
    {
      def: createGrepToolDefinition(cwd),
      view: { lines: 6, keep: "head" },
      detail(args, theme, c) {
        if (!args?.pattern) return undefined;
        const where = [shortPath(args.path, c), args.glob].filter(Boolean).join(" ");
        return theme.fg("text", args.pattern) + (where ? theme.fg("muted", ` in ${where}`) : "");
      },
    },
    {
      def: createFindToolDefinition(cwd),
      view: { lines: 6, keep: "head" },
      detail(args, theme, c) {
        if (!args?.pattern) return undefined;
        return theme.fg("text", args.pattern) + (args.path ? theme.fg("muted", ` in ${shortPath(args.path, c)}`) : "");
      },
    },
    { def: createLsToolDefinition(cwd), view: { lines: 6, keep: "head" }, detail: pathDetail },
  ];
}

export default function builtinRestyleExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const s = piSettings();
  for (const { def, detail, view, timed } of restyles(cwd, s)) {
    pi.registerTool({
      ...def,
      renderShell: "self",
      renderCall(args: any, theme: any, ctx: any) {
        if (timed && ctx.executionStarted && ctx.state.startedAt === undefined) ctx.state.startedAt = Date.now();
        return header(theme, ctx, def.name, detail(args, theme, ctx.cwd));
      },
      renderResult(result: any, options: any, theme: any, ctx: any) {
        if (timed && !options.isPartial && ctx.state.startedAt !== undefined && ctx.state.endedAt === undefined) {
          ctx.state.endedAt = Date.now();
        }
        const output = body(theme, ctx, result, view);
        if (!timed || ctx.state.startedAt === undefined) return output;
        const ms = (ctx.state.endedAt ?? Date.now()) - ctx.state.startedAt;
        return stack(output, new Text(indent(theme.fg("dim", `${(ms / 1000).toFixed(1)}s`)), 0, 0));
      },
    });
  }
}
