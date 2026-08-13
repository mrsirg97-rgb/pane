import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorText, header, indent, progressBar } from "./_render-kit.mjs";

const DIR = join(homedir(), ".pi/agent/todos");

type Status = "pending" | "in_progress" | "done" | "failed";
type Task = { id: string; text: string; status: Status };

const ACTION = StringEnum([
  "create",
  "start",
  "complete",
  "fail",
  "retry",
  "read",
] as const);
const MARK: Record<Status, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  failed: "[!]",
};

function storePath(): string {
  const key = createHash("sha1")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 12);
  return join(DIR, `${key}.json`);
}

function load(): Task[] {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Record<
      string,
      unknown
    >[];
    const tasks: Task[] = raw.map((e, i) => ({
      id: typeof e.id === "string" ? e.id : `t${i + 1}`,
      text: String(e.text ?? e.task ?? ""),
      status: (["pending", "in_progress", "done", "failed"].includes(
        e.status as string,
      )
        ? e.status
        : "pending") as Status,
    }));
    if (raw.some((e) => typeof e.id !== "string" || e.task !== undefined))
      save(tasks);
    return tasks;
  } catch {
    return [];
  }
}

function save(tasks: Task[]) {
  mkdirSync(DIR, { recursive: true });
  const p = storePath();
  writeFileSync(`${p}.tmp`, JSON.stringify(tasks, null, 1));
  renameSync(`${p}.tmp`, p); // atomic: a crash never leaves a corrupt store
}

function maxIdNum(tasks: Task[]): number {
  let max = 0;
  for (const t of tasks) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function find(tasks: Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

function fail(message: string): never {
  throw new Error(`todo: ${message}`);
}

let busy: Promise<void> = Promise.resolve();
async function withLog<T>(fn: () => T): Promise<T> {
  const prev = busy;
  let release!: () => void;
  busy = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return fn();
  } finally {
    release();
  }
}

const TASK_GLYPH: Record<Status, [string, string]> = {
  pending: ["○", "dim"],
  in_progress: ["◐", "accent"],
  done: ["●", "success"],
  failed: ["✕", "error"],
};

function renderQueue(theme: any, tasks: Task[]): string {
  if (!tasks.length) return theme.fg("dim", "(no tasks)");
  const done = tasks.filter((t) => t.status === "done").length;
  const next = tasks.find((t) => t.status === "pending");
  const head =
    `${progressBar(theme, done, tasks.length)} ` +
    theme.fg(
      "muted",
      `${done}/${tasks.length}` +
        (next
          ? ` · next ${next.id}`
          : done === tasks.length
            ? " · all done"
            : ""),
    );
  const rows = tasks.map((t) => {
    const [glyph, color] = TASK_GLYPH[t.status];
    const text =
      t.status === "done"
        ? theme.fg("dim", t.text)
        : theme.fg(t.status === "failed" ? "error" : "text", t.text);
    return `${theme.fg(color, glyph)} ${theme.fg("dim", t.id)} ${text}`;
  });
  return [head, ...rows].join("\n");
}

function render(tasks: Task[]): string {
  if (!tasks.length) return "(no tasks)";
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const next = tasks.find((t) => t.status === "pending");
  const lines = tasks.map((t) => `  ${t.id} ${MARK[t.status]} ${t.text}`);
  const head =
    `${done}/${tasks.length} done` +
    (next ? ` · next: ${next.id}` : "") +
    (failed ? ` · ${failed} failed` : "");
  return `${head}\n${lines.join("\n")}`;
}

export default function todoExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Task queue per working directory. action REQUIRED. create replaces the queue (tasks: [{text}]); " +
      "start/complete/fail/retry transition one task by id; read prints it. " +
      "pending -> in_progress -> done (read-only) or failed; failed -> retry -> pending. " +
      "several tasks may be in flight; batched transitions apply in order, each against fresh state. " +
      "every mutation returns the full queue. ids are minted by the tool; copy, never invent.",
    promptSnippet: "Track and update a task queue for multi-step work",
    promptGuidelines: [
      "3+ steps or multi-file -> todo create first, then work. start before working a task; done/fail the moment it finishes.",
      "work grew past 3 steps mid-task -> stop, create the queue, continue.",
      "concurrent work -> several in flight is fine; batch transitions when several finish together.",
      "done is read-only; failed -> retry before start. single-step task -> skip todo.",
    ],
    parameters: Type.Object({
      action: ACTION,
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String({ description: "What needs doing" }),
          }),
          {
            description:
              "Full replacement queue. Required when action='create'.",
          },
        ),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Task id as shown by the tool. Required for start/complete/fail/retry.",
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args: any, theme, ctx) {
      const detail =
        args?.action === "create"
          ? theme.fg("text", `${args?.tasks?.length ?? 0} tasks`)
          : args?.action
            ? theme.fg("text", [args.action, args.id].filter(Boolean).join(" "))
            : undefined;
      return header(theme, ctx, "todo", detail);
    },
    renderResult(result, _options, theme, _ctx) {
      if (result.isError) return errorText(theme, result);
      const tasks =
        (result.details as { tasks?: Task[] } | undefined)?.tasks ?? [];
      return new Text(indent(renderQueue(theme, tasks)), 0, 0);
    },
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as { items?: { task: string }[] };
      if (Array.isArray(input.items)) {
        return {
          action: "create",
          tasks: input.items.map((i) => ({ text: String(i.task) })),
        };
      }
      return args;
    },
    async execute(_toolCallId, params: any) {
      return withLog(() => {
        const action = params.action;
        const tasks = load();
        const reply = (note?: string) => {
          const text = [note && `→ ${note}`, render(tasks)]
            .filter(Boolean)
            .join("\n");
          return {
            content: [{ type: "text", text }],
            details: { action, tasks },
          };
        };

        if (action === "read") return reply();
        if (action === "create") {
          const incoming =
            params.tasks ??
            fail("action 'create' requires tasks: array of {text}");
          let n = maxIdNum(tasks);
          const created: Task[] = incoming.map((t: { text?: unknown }, i) => ({
            id: `t${++n}`,
            text: String(t.text ?? ""),
            status: "pending",
          }));
          save(created);
          tasks.splice(0, tasks.length, ...created);
          return reply(
            created.length
              ? `queue replaced with ${created.length} tasks`
              : "queue cleared",
          );
        }

        const id = params.id ?? fail(`action '${action}' requires id`);
        const t = find(tasks, id) ?? fail(`no task '${id}'`);
        if (action === "start") {
          if (t.status === "in_progress")
            fail(`'${id}' is already in progress`);
          if (t.status === "done") fail(`'${id}' is done; read-only`);
          if (t.status === "failed") fail(`'${id}' failed; retry it first`);
          t.status = "in_progress";
          save(tasks);
          return reply(`'${id}' started`);
        }

        if (action === "complete") {
          if (t.status === "pending")
            fail(`'${id}' is pending; start it first`);
          if (t.status === "done") fail(`'${id}' is done; read-only`);
          if (t.status === "failed") fail(`'${id}' failed; retry it first`);
          t.status = "done";
          save(tasks);
          return reply(`'${id}' completed`);
        }

        if (action === "fail") {
          if (t.status === "pending")
            fail(`'${id}' is pending; start it first`);
          if (t.status === "done") fail(`'${id}' is done; read-only`);
          if (t.status === "failed") fail(`'${id}' is already failed`);
          t.status = "failed";
          save(tasks);
          return reply(`'${id}' failed`);
        }

        if (t.status !== "failed")
          fail(`'${id}' is not failed; nothing to retry`);
        t.status = "pending";
        save(tasks);
        return reply(`'${id}' back to pending`);
      });
    },
  });
}
