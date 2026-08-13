import { mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorText, header, indent, progressBar } from "./_render-kit.mjs";

const DIR = join(homedir(), ".pi/agent/todos");

/** Staleness threshold in event-count, not wall-clock: a task whose last update is
 *  this many events behind the latest seq is "stale". ~24h of activity. */
export const STALE_THRESHOLD_SEQ = 200;

type Status = "pending" | "in_progress" | "done" | "failed";
type Task = { id: string; text: string; status: Status };
type StoredTask = Task & {
  pos: number;
  created_seq: number;
  updated_seq: number;
};

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  op TEXT NOT NULL CHECK (op IN ('create', 'start', 'complete', 'fail', 'retry')),
  args TEXT NOT NULL,
  session TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  pos INTEGER NOT NULL,
  created_seq INTEGER NOT NULL REFERENCES events(seq),
  updated_seq INTEGER NOT NULL REFERENCES events(seq)
);
CREATE INDEX IF NOT EXISTS tasks_pos_seq ON tasks (pos, created_seq);
`;

function dbPath(): string {
  const key = createHash("sha1")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 12);
  return join(DIR, `${key}.sqlite`);
}

/** Open the workspace database. Fail closed on corruption: a database that fails
 *  to open or fails integrity check is recreated empty, never partially read. */
function openDb(): DatabaseSync {
  const p = dbPath();
  mkdirSync(DIR, { recursive: true });
  try {
    const db = new DatabaseSync(p);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    const check = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: string;
    };
    if (check && check.integrity_check === "ok") {
      return db;
    }
    db.close();
  } catch {
    // corrupt or unreadable: fall through to recreate
  }
  rmSync(p, { force: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

/** Replay the event log into a projection map. Total: never throws; bad rows are skipped. */
function replay(db: DatabaseSync): Map<string, StoredTask> {
  const map = new Map<string, StoredTask>();
  const events = db
    .prepare("SELECT seq, op, args FROM events ORDER BY seq")
    .all() as {
    seq: number;
    op: string;
    args: string;
  }[];
  for (const ev of events) {
    let args: { tasks?: { text?: unknown }[]; id?: string } = {};
    try {
      args = JSON.parse(ev.args) as {
        tasks?: { text?: unknown }[];
        id?: string;
      };
    } catch {
      continue; // corrupt row: skip, never fatal
    }
    applyEvent(map, ev.seq, ev.op as Op, args);
  }
  return map;
}

type Op = "create" | "start" | "complete" | "fail" | "retry";

/** Apply one event to the projection. Deterministic; inapplicable transitions are no-ops. */
function applyEvent(
  map: Map<string, StoredTask>,
  seq: number,
  op: Op,
  args: { tasks?: { text?: unknown }[]; id?: string },
) {
  if (op === "create") {
    const incoming = args.tasks ?? [];
    if (incoming.length === 0) {
      map.clear();
      return;
    }
    let maxId = 0;
    let maxPos = -1;
    for (const t of map.values()) {
      const m = /^t(\d+)$/.exec(t.id);
      if (m) maxId = Math.max(maxId, Number(m[1]));
      maxPos = Math.max(maxPos, t.pos);
    }
    for (const inc of incoming) {
      const text = String(inc?.text ?? "");
      const existing = [...map.values()].find((t) => t.text === text);
      if (existing) continue; // upsert: keep id, status, position
      const id = `t${++maxId}`;
      maxPos++;
      map.set(id, {
        id,
        text,
        status: "pending",
        pos: maxPos,
        created_seq: seq,
        updated_seq: seq,
      });
    }
    return;
  }

  const id = typeof args.id === "string" ? args.id : "";
  const t = map.get(id);
  if (!t) return; // unknown id: no-op on replay
  if (op === "start" && t.status === "pending") {
    t.status = "in_progress";
    t.updated_seq = seq;
  } else if (op === "complete" && t.status === "in_progress") {
    t.status = "done";
    t.updated_seq = seq;
  } else if (op === "fail" && t.status === "in_progress") {
    t.status = "failed";
    t.updated_seq = seq;
  } else if (op === "retry" && t.status === "failed") {
    t.status = "pending";
    t.updated_seq = seq;
  }
}

/** Persist the projection (DELETE + INSERT all rows). Caller owns the transaction. */
function persist(db: DatabaseSync, map: Map<string, StoredTask>) {
  db.exec("DELETE FROM tasks");
  const insert = db.prepare(
    "INSERT INTO tasks (id, text, status, pos, created_seq, updated_seq) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const ordered = [...map.values()].sort(
    (a, b) => a.pos - b.pos || a.created_seq - b.created_seq,
  );
  for (const t of ordered) {
    insert.run(t.id, t.text, t.status, t.pos, t.created_seq, t.updated_seq);
  }
}

/** One-line footer when the workspace has unresolved (stale) history, else null. */
function staleFooter(db: DatabaseSync): string | null {
  const latest = db.prepare("SELECT MAX(seq) AS m FROM events").get() as {
    m: number | null;
  };
  if (!latest?.m || latest.m <= STALE_THRESHOLD_SEQ) return null;
  const rows = db
    .prepare(
      `SELECT t.id, t.text, t.status, e.ts AS updated_ts
       FROM tasks t JOIN events e ON e.seq = t.updated_seq
       WHERE t.status IN ('pending', 'in_progress')
         AND t.updated_seq <= ?`,
    )
    .all(latest.m - STALE_THRESHOLD_SEQ) as { updated_ts: string }[];
  if (rows.length === 0) return null;
  const latestTs = rows.reduce(
    (max, r) => (r.updated_ts > max ? r.updated_ts : max),
    rows[0].updated_ts,
  );
  return `· ${rows.length} pending since ${latestTs.slice(0, 10)} (recovered from log)`;
}

function maxIdNum(tasks: Iterable<StoredTask>): number {
  let max = 0;
  for (const t of tasks) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function find(
  map: Map<string, StoredTask>,
  id: string,
): StoredTask | undefined {
  return map.get(id);
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
        const db = openDb();
        try {
          db.exec("BEGIN IMMEDIATE");
          const map = replay(db);

          const reply = (note?: string) => {
            const ordered = [...map.values()].sort(
              (a, b) => a.pos - b.pos || a.created_seq - b.created_seq,
            );
            const tasks: Task[] = ordered.map((t) => ({
              id: t.id,
              text: t.text,
              status: t.status,
            }));
            const footer = staleFooter(db);
            const text = [note && `→ ${note}`, render(tasks), footer]
              .filter(Boolean)
              .join("\n");
            return {
              content: [{ type: "text", text }],
              details: { action, tasks },
            };
          };

          if (action === "read") {
            persist(db, map);
            db.exec("COMMIT");
            return reply();
          }

          if (action === "create") {
            const incoming =
              params.tasks ??
              fail("action 'create' requires tasks: array of {text}");
            const append = db
              .prepare(
                "INSERT INTO events (op, args, session) VALUES ('create', ?, NULL)",
              )
              .run(JSON.stringify({ tasks: incoming }));
            applyEvent(map, Number(append.lastInsertRowid), "create", {
              tasks: incoming,
            });
            persist(db, map);
            db.exec("COMMIT");
            return reply(
              incoming.length
                ? `queue replaced with ${incoming.length} tasks`
                : "queue cleared",
            );
          }

          const id = params.id ?? fail(`action '${action}' requires id`);
          const t = find(map, id) ?? fail(`no task '${id}'`);
          if (action === "start") {
            if (t.status === "in_progress")
              fail(`'${id}' is already in progress`);
            if (t.status === "done") fail(`'${id}' is done; read-only`);
            if (t.status === "failed") fail(`'${id}' failed; retry it first`);
            const append = db
              .prepare(
                "INSERT INTO events (op, args, session) VALUES ('start', ?, NULL)",
              )
              .run(JSON.stringify({ id }));
            applyEvent(map, Number(append.lastInsertRowid), "start", { id });
            persist(db, map);
            db.exec("COMMIT");
            return reply(`'${id}' started`);
          }

          if (action === "complete") {
            if (t.status === "pending")
              fail(`'${id}' is pending; start it first`);
            if (t.status === "done") fail(`'${id}' is done; read-only`);
            if (t.status === "failed") fail(`'${id}' failed; retry it first`);
            const append = db
              .prepare(
                "INSERT INTO events (op, args, session) VALUES ('complete', ?, NULL)",
              )
              .run(JSON.stringify({ id }));
            applyEvent(map, Number(append.lastInsertRowid), "complete", { id });
            persist(db, map);
            db.exec("COMMIT");
            return reply(`'${id}' completed`);
          }

          if (action === "fail") {
            if (t.status === "pending")
              fail(`'${id}' is pending; start it first`);
            if (t.status === "done") fail(`'${id}' is done; read-only`);
            if (t.status === "failed") fail(`'${id}' is already failed`);
            const append = db
              .prepare(
                "INSERT INTO events (op, args, session) VALUES ('fail', ?, NULL)",
              )
              .run(JSON.stringify({ id }));
            applyEvent(map, Number(append.lastInsertRowid), "fail", { id });
            persist(db, map);
            db.exec("COMMIT");
            return reply(`'${id}' failed`);
          }

          if (t.status !== "failed")
            fail(`'${id}' is not failed; nothing to retry`);
          const append = db
            .prepare(
              "INSERT INTO events (op, args, session) VALUES ('retry', ?, NULL)",
            )
            .run(JSON.stringify({ id }));
          applyEvent(map, Number(append.lastInsertRowid), "retry", { id });
          persist(db, map);
          db.exec("COMMIT");
          return reply(`'${id}' back to pending`);
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* already committed or never begun */
          }
          throw err;
        } finally {
          try {
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } catch {
            /* read-only or closed */
          }
          db.close();
        }
      });
    },
  });
}
