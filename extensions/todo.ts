import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, withLog, withStore } from "./sqlite.ts";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { errorText, header, indent, progressBar } from "./_render-kit.mjs";

const DIR = join(homedir(), ".pi/agent/todos");

export const STALE_THRESHOLD_SEQ = 200;
export const COMPACT_THRESHOLD_EVENTS = 1000;

type Status = "pending" | "in_progress" | "done" | "failed";
type Task = {
  id: string;
  text: string;
  status: Status;
  dependsOn: string | null;
};
type TaskView = Task & { blockedBy: string | null; owner: string | null };
type StoredTask = Task & {
  pos: number;
  created_seq: number;
  updated_seq: number;
  owner: string | null;
};

const ACTION = StringEnum([
  "create",
  "start",
  "complete",
  "fail",
  "retry",
  "move",
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
  op TEXT NOT NULL CHECK (op IN ('create', 'start', 'complete', 'fail', 'retry', 'move', 'compact')),
  args TEXT NOT NULL,
  session TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  depends_on TEXT,
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

function storeOpts(): { path: string; schema: string; policy: "delete" } {
  return { path: dbPath(), schema: SCHEMA, policy: "delete" };
}

function replay(db: DatabaseSync): Map<string, StoredTask> {
  const map = new Map<string, StoredTask>();
  const events = db
    .prepare("SELECT seq, op, args, session FROM events ORDER BY seq")
    .all() as {
    seq: number;
    op: string;
    args: string;
    session: string | null;
  }[];
  for (const ev of events) {
    let args: {
      tasks?: { text?: unknown; dependsOn?: unknown }[];
      id?: string;
    } = {};
    try {
      args = JSON.parse(ev.args) as {
        tasks?: { text?: unknown; dependsOn?: unknown }[];
        id?: string;
      };
    } catch {
      continue; // corrupt row: skip, never fatal
    }
    applyEvent(map, ev.seq, ev.op as Op, args, ev.session);
  }
  return map;
}

type Op =
  "create" | "start" | "complete" | "fail" | "retry" | "move" | "compact";

type PlannedRow = {
  text: string;
  id: string;
  pos: number;
  dependsOn: string | null | undefined; // undefined: keep an existing link
};
type Plan = { rows: PlannedRow[]; problems: string[] };

function planCreate(
  map: Map<string, StoredTask>,
  incoming: { text?: unknown; dependsOn?: unknown }[],
): Plan {
  const items = incoming.map((raw) => ({
    text: String(raw?.text ?? ""),
    dependsOn:
      typeof raw?.dependsOn === "string"
        ? (raw.dependsOn as string)
        : raw?.dependsOn === null
          ? null
          : undefined,
  }));
  let maxId = 0;
  let maxPos = -1;
  for (const t of map.values()) {
    const m = /^t(\d+)$/.exec(t.id);
    if (m) maxId = Math.max(maxId, Number(m[1]));
    maxPos = Math.max(maxPos, t.pos);
  }
  const rows: PlannedRow[] = [];
  const seen = new Set<string>();
  const textIds = new Map<string, string>(); // text -> id, existing then planned
  for (const t of map.values()) textIds.set(t.text, t.id);
  for (const inc of items) {
    if (seen.has(inc.text)) continue; // first occurrence wins
    seen.add(inc.text);
    let id = textIds.get(inc.text);
    if (!id) {
      id = `t${++maxId}`;
      maxPos++;
      textIds.set(inc.text, id);
    }
    rows.push({ text: inc.text, id, pos: maxPos, dependsOn: inc.dependsOn });
  }
  const problems: string[] = [];
  const ids = new Set<string>(); // existing ids only; batch-internal refs are textual
  for (const t of map.values()) ids.add(t.id);
  for (const row of rows) {
    const d = row.dependsOn;
    if (typeof d !== "string") continue;
    const resolved = ids.has(d) ? d : textIds.get(d);
    if (resolved) {
      if (resolved === row.id)
        problems.push(`'${row.text}' cannot depend on itself`);
      row.dependsOn = resolved;
    } else {
      problems.push(`dependsOn '${d}' not found`);
      row.dependsOn = null;
    }
  }
  return { rows, problems };
}

function applyCreate(map: Map<string, StoredTask>, seq: number, plan: Plan) {
  for (const row of plan.rows) {
    if (map.has(row.id)) continue; // existing: link handled in pass 2
    map.set(row.id, {
      id: row.id,
      text: row.text,
      status: "pending",
      dependsOn: row.dependsOn === undefined ? null : row.dependsOn,
      pos: row.pos,
      created_seq: seq,
      updated_seq: seq,
      owner: null,
    });
  }
  for (const row of plan.rows) {
    const d = row.dependsOn;
    if (d === undefined) continue; // keep an existing link
    const t = map.get(row.id);
    if (!t) continue;
    t.dependsOn = map.has(d) ? d : null;
    t.updated_seq = seq;
  }
}

function cycleProblem(
  map: Map<string, StoredTask>,
  plan: Plan,
): string[] | null {
  const next = new Map<string, string>(); // id -> dependency id
  for (const t of map.values()) {
    if (t.dependsOn) next.set(t.id, t.dependsOn);
  }
  for (const row of plan.rows) {
    if (row.dependsOn) next.set(row.id, row.dependsOn);
    else if (row.dependsOn === null && map.has(row.id)) next.delete(row.id);
  }
  const color = new Map<string, 1 | 2>(); // 1 visiting, 2 done
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    const c = color.get(id);
    if (c === 2) return null;
    if (c === 1) return path.slice(path.indexOf(id)).concat(id); // back edge
    color.set(id, 1);
    path.push(id);
    const dep = next.get(id);
    const cycle = dep ? visit(dep) : null;
    path.pop();
    color.set(id, 2);
    return cycle;
  };
  for (const id of next.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function validateDeps(map: Map<string, StoredTask>, plan: Plan): void {
  if (plan.problems.length) fail(plan.problems[0]);
  const cycle = cycleProblem(map, plan);
  if (cycle) fail(`dependencies would form a cycle: ${cycle.join(" -> ")}`);
}

function applyEvent(
  map: Map<string, StoredTask>,
  seq: number,
  op: Op,
  args: { tasks?: { text?: unknown; dependsOn?: unknown }[]; id?: string },
  session?: string | null,
) {
  if (op === "create") {
    const incoming = args.tasks ?? [];
    if (incoming.length === 0) {
      map.clear();
      return;
    }
    applyCreate(map, seq, planCreate(map, incoming));
    return;
  }
  if (op === "compact") {
    applyCompact(map, seq, args);
    return;
  }

  const id = typeof args.id === "string" ? args.id : "";
  const t = map.get(id);
  if (!t) return; // unknown id: no-op on replay
  if (op === "start" && t.status === "pending") {
    t.status = "in_progress";
    t.owner = session ?? null;
    t.updated_seq = seq;
  } else if (op === "complete" && t.status === "in_progress") {
    t.status = "done";
    t.owner = null;
    t.updated_seq = seq;
  } else if (op === "fail" && t.status === "in_progress") {
    t.status = "failed";
    t.owner = null;
    t.updated_seq = seq;
  } else if (op === "retry" && t.status === "failed") {
    t.status = "pending";
    t.owner = null;
    t.updated_seq = seq;
  } else if (op === "move") {
    applyMove(map, seq, args);
  }
}

function applyCompact(
  map: Map<string, StoredTask>,
  seq: number,
  args: { tasks?: unknown },
) {
  map.clear();
  const raw = Array.isArray(args.tasks) ? args.tasks : [];
  const rows: {
    id: string;
    text: string;
    status: Status;
    dependsOn: string | null;
    pos: number;
    owner: string | null;
  }[] = [];
  for (const entry of raw) {
    const r = entry as {
      id?: unknown;
      text?: unknown;
      status?: unknown;
      dependsOn?: unknown;
      pos?: unknown;
      owner?: unknown;
    };
    const id = typeof r.id === "string" ? r.id : "";
    const text = typeof r.text === "string" ? r.text : "";
    if (!id || !text) continue;
    const status =
      r.status === "pending" ||
      r.status === "in_progress" ||
      r.status === "done" ||
      r.status === "failed"
        ? r.status
        : "pending";
    const pos = typeof r.pos === "number" ? r.pos : 0;
    rows.push({
      id,
      text,
      status,
      dependsOn: typeof r.dependsOn === "string" ? r.dependsOn : null,
      pos,
      owner: typeof r.owner === "string" ? r.owner : null,
    });
  }
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      text: row.text,
      status: row.status,
      dependsOn: row.dependsOn,
      pos: row.pos,
      created_seq: seq,
      updated_seq: seq,
      owner: row.owner,
    });
  }
  for (const row of rows) {
    const t = map.get(row.id);
    if (t && row.dependsOn && !map.has(row.dependsOn)) t.dependsOn = null;
  }
}

function compact(
  db: DatabaseSync,
  map: Map<string, StoredTask>,
  session: string,
) {
  const ordered = [...map.values()].sort(
    (a, b) => a.pos - b.pos || a.created_seq - b.created_seq,
  );
  const tasks = ordered.map((t) => ({
    id: t.id,
    text: t.text,
    status: t.status,
    dependsOn: t.dependsOn,
    pos: t.pos,
    owner: t.owner,
  }));
  const append = db
    .prepare("INSERT INTO events (op, args, session) VALUES ('compact', ?, ?)")
    .run(JSON.stringify({ tasks }), session);
  const seq = Number(append.lastInsertRowid);
  for (const t of map.values()) {
    t.created_seq = seq;
    t.updated_seq = seq;
  }
  persist(db, map); // rewrite the projection first: its seq refs must survive the delete
  db.prepare("DELETE FROM events WHERE seq < ?").run(seq);
}

function applyMove(
  map: Map<string, StoredTask>,
  seq: number,
  args: { id?: unknown; pos?: unknown },
) {
  const id = typeof args.id === "string" ? args.id : "";
  const t = map.get(id);
  if (!t) return;
  const pos = typeof args.pos === "number" ? args.pos : NaN;
  if (!Number.isInteger(pos) || pos < 1 || pos > map.size) return;
  const ordered = [...map.values()].sort(
    (a, b) => a.pos - b.pos || a.created_seq - b.created_seq,
  );
  const idx = ordered.findIndex((x) => x.id === id);
  if (idx === -1 || idx === pos - 1) return; // already there: no-op
  ordered.splice(idx, 1);
  ordered.splice(pos - 1, 0, t);
  ordered.forEach((x, i) => {
    x.pos = i;
  });
  t.updated_seq = seq;
}

function persist(db: DatabaseSync, map: Map<string, StoredTask>) {
  db.exec("DELETE FROM tasks");
  const insert = db.prepare(
    "INSERT INTO tasks (id, text, status, depends_on, pos, created_seq, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const ordered = [...map.values()].sort(
    (a, b) => a.pos - b.pos || a.created_seq - b.created_seq,
  );
  for (const t of ordered) {
    insert.run(
      t.id,
      t.text,
      t.status,
      t.dependsOn,
      t.pos,
      t.created_seq,
      t.updated_seq,
    );
  }
}

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
  return `· ${rows.length} unresolved since ${latestTs.slice(0, 10)} (recovered from log)`;
}

function find(
  map: Map<string, StoredTask>,
  id: string,
): StoredTask | undefined {
  return map.get(id);
}

function blockedBy(map: Map<string, StoredTask>, t: StoredTask): string | null {
  if (t.status !== "pending" && t.status !== "in_progress") return null;
  const d = t.dependsOn;
  if (!d) return null;
  const dep = map.get(d);
  return dep && dep.status !== "done" ? d : null;
}

function fail(message: string): never {
  throw new Error(`todo: ${message}`);
}

function currentSession(ctx?: {
  sessionManager?: { getSessionId?: () => string };
}): string {
  const id = ctx?.sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length ? id : "anon";
}

function claimSuffix(t: TaskView, session: string): string {
  if (t.status !== "in_progress" || !t.owner || t.owner === session) return "";
  return ` · claimed by ${t.owner.slice(0, 8)}`;
}

const TASK_GLYPH: Record<Status, [string, string]> = {
  pending: ["○", "dim"],
  in_progress: ["◐", "accent"],
  done: ["●", "success"],
  failed: ["✕", "error"],
};

function renderQueue(theme: any, tasks: TaskView[], session: string): string {
  if (!tasks.length) return theme.fg("dim", "(no tasks)");
  const done = tasks.filter((t) => t.status === "done").length;
  const next = tasks.find((t) => t.status === "pending" && !t.blockedBy);
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
    const waits = t.blockedBy
      ? theme.fg("dim", ` · waits on ${t.blockedBy}`)
      : "";
    const claim = claimSuffix(t, session);
    return `${theme.fg(color, glyph)} ${theme.fg("dim", t.id)} ${text}${waits}${claim}`;
  });
  return [head, ...rows].join("\n");
}

function render(tasks: TaskView[], session: string): string {
  if (!tasks.length) return "(no tasks)";
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const next = tasks.find((t) => t.status === "pending" && !t.blockedBy);
  const lines = tasks.map(
    (t) =>
      `  ${t.id} ${MARK[t.status]} ${t.text}` +
      (t.blockedBy ? ` · waits on ${t.blockedBy}` : "") +
      claimSuffix(t, session),
  );
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
      "create may link tasks into a tree: tasks[].dependsOn (task id or exact text; null clears a link); " +
      "a task is blocked until its dependency is done; cycles are refused; next skips blocked tasks. " +
      "several tasks may be in flight; batched transitions apply in order, each against fresh state. " +
      "move reorders the queue: action='move' id + pos (1-based queue position); positions are " +
      "minted as events, never updated in place. " +
      "events record the claiming session; start claims, complete by a foreign session refuses " +
      "(fail it first to take over), fail frees the claim. " +
      "the event log auto-compacts past 1000 events: a full-state snapshot replaces history " +
      "(staleness epochs reset), replay stays exact. " +
      "every mutation returns the full queue. ids are minted by the tool; copy, never invent.",
    promptSnippet: "Track and update a task queue for multi-step work",
    promptGuidelines: [
      "3+ steps or multi-file -> todo create first, then work. start before working a task; done/fail the moment it finishes.",
      "work grew past 3 steps mid-task -> stop, create the queue, continue.",
      "concurrent work -> several in flight is fine; batch transitions when several finish together.",
      "done is read-only; failed -> retry before start. single-step task -> skip todo.",
      "dependencies: dependsOn at create (task id or exact text; null clears); complete blocked tasks only after their dependency is done; next skips blocked.",
    ],
    parameters: Type.Object({
      action: ACTION,
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String({ description: "What needs doing" }),
            dependsOn: Type.Optional(
              Type.Union([
                Type.String({
                  description:
                    "Task id (tN) or exact text this task depends on; null clears the link",
                }),
                Type.Null(),
              ]),
            ),
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
      pos: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Queue position (1-based, first = 1) for action='move'.",
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
      // The render context has no session; the reply stamps who answered.
      const d = result.details as
        { tasks?: TaskView[]; session?: string } | undefined;
      return new Text(
        indent(renderQueue(theme, d?.tasks ?? [], d?.session ?? "anon")),
        0,
        0,
      );
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
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      return withLog(() =>
        withStore(
          storeOpts(),
          (db) => db,
          (db) => {
            const action = params.action;
            const session = currentSession(ctx);
            const map = replay(db);

            if (action !== "read") {
              const count = db
                .prepare("SELECT COUNT(*) AS c FROM events")
                .get() as { c: number };
              if (count.c >= COMPACT_THRESHOLD_EVENTS)
                compact(db, map, session);
            }

            const reply = (note?: string) => {
              const ordered = [...map.values()].sort(
                (a, b) => a.pos - b.pos || a.created_seq - b.created_seq,
              );
              const tasks: TaskView[] = ordered.map((t) => ({
                id: t.id,
                text: t.text,
                status: t.status,
                dependsOn: t.dependsOn,
                blockedBy: blockedBy(map, t),
                owner: t.owner,
              }));
              const footer = staleFooter(db);
              const text = [note && `→ ${note}`, render(tasks, session), footer]
                .filter(Boolean)
                .join("\n");
              return {
                content: [{ type: "text", text }],
                details: { action, tasks, session },
              };
            };

            if (action === "read") {
              persist(db, map);
              return reply();
            }

            if (action === "create") {
              const incoming =
                params.tasks ??
                fail("action 'create' requires tasks: array of {text}");
              const plan = planCreate(map, incoming);
              validateDeps(map, plan);
              const append = db
                .prepare(
                  "INSERT INTO events (op, args, session) VALUES ('create', ?, ?)",
                )
                .run(JSON.stringify({ tasks: incoming }), session);
              applyEvent(
                map,
                Number(append.lastInsertRowid),
                "create",
                { tasks: incoming },
                session,
              );
              persist(db, map);
              return reply(
                incoming.length
                  ? `queue replaced with ${incoming.length} tasks`
                  : "queue cleared",
              );
            }

            const id = params.id ?? fail(`action '${action}' requires id`);
            const t = find(map, id) ?? fail(`no task '${id}'`);
            if (action === "move") {
              const pos = params.pos ?? fail("action 'move' requires pos");
              if (!Number.isInteger(pos) || pos < 1 || pos > map.size) {
                fail(
                  `move position for '${id}' must be between 1 and ${map.size}, got ${pos}`,
                );
              }
              const append = db
                .prepare(
                  "INSERT INTO events (op, args, session) VALUES ('move', ?, ?)",
                )
                .run(JSON.stringify({ id, pos }), session);
              applyEvent(
                map,
                Number(append.lastInsertRowid),
                "move",
                { id, pos },
                session,
              );
              persist(db, map);
              return reply(`'${id}' moved to position ${pos}`);
            }

            if (action === "start") {
              if (t.status === "in_progress")
                fail(
                  `'${id}' is already in progress` +
                    (t.owner ? ` (claimed by ${t.owner})` : ""),
                );
              if (t.status === "done") fail(`'${id}' is done; read-only`);
              if (t.status === "failed") fail(`'${id}' failed; retry it first`);
              const append = db
                .prepare(
                  "INSERT INTO events (op, args, session) VALUES ('start', ?, ?)",
                )
                .run(JSON.stringify({ id }), session);
              applyEvent(
                map,
                Number(append.lastInsertRowid),
                "start",
                { id },
                session,
              );
              persist(db, map);
              return reply(`'${id}' started`);
            }

            if (action === "complete") {
              if (t.status === "pending")
                fail(`'${id}' is pending; start it first`);
              if (t.status === "done") fail(`'${id}' is done; read-only`);
              if (t.status === "failed") fail(`'${id}' failed; retry it first`);
              if (t.owner && t.owner !== session) {
                fail(
                  `'${id}' is claimed by ${t.owner}; fail it first to take over`,
                );
              }
              const depId = t.dependsOn;
              const blocker = depId ? find(map, depId) : undefined;
              if (blocker && blocker.status !== "done") {
                const hint =
                  blocker.status === "pending"
                    ? "pending; start it first"
                    : blocker.status === "failed"
                      ? "failed; retry it first"
                      : "in_progress";
                fail(`'${id}' is blocked by '${depId}' (${hint})`);
              }
              const append = db
                .prepare(
                  "INSERT INTO events (op, args, session) VALUES ('complete', ?, ?)",
                )
                .run(JSON.stringify({ id }), session);
              applyEvent(
                map,
                Number(append.lastInsertRowid),
                "complete",
                { id },
                session,
              );
              persist(db, map);
              return reply(`'${id}' completed`);
            }

            if (action === "fail") {
              if (t.status === "pending")
                fail(`'${id}' is pending; start it first`);
              if (t.status === "done") fail(`'${id}' is done; read-only`);
              if (t.status === "failed") fail(`'${id}' is already failed`);
              const released = t.owner && t.owner !== session ? t.owner : null;
              const append = db
                .prepare(
                  "INSERT INTO events (op, args, session) VALUES ('fail', ?, ?)",
                )
                .run(JSON.stringify({ id }), session);
              applyEvent(
                map,
                Number(append.lastInsertRowid),
                "fail",
                { id },
                session,
              );
              persist(db, map);
              return reply(
                released
                  ? `'${id}' failed (released from ${released})`
                  : `'${id}' failed`,
              );
            }

            if (t.status !== "failed")
              fail(`'${id}' is not failed; nothing to retry`);
            const append = db
              .prepare(
                "INSERT INTO events (op, args, session) VALUES ('retry', ?, ?)",
              )
              .run(JSON.stringify({ id }), session);
            applyEvent(
              map,
              Number(append.lastInsertRowid),
              "retry",
              { id },
              session,
            );
            persist(db, map);
            return reply(`'${id}' back to pending`);
          },
        ),
      );
    },
  });
}
