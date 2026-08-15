import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CompactArgs,
  CreateArgs,
  IdArgs,
  Op,
  RunArgs,
  Scope,
  StoredJob,
} from "../types/scheduler.types.ts";

// Per-scope sqlite stores with todo's event-log discipline: events are
// append-only truth, the jobs table is a replayable projection. Removed jobs
// stay as tombstones so ids and names are never reused and remove survives
// compaction.

export const COMPACT_THRESHOLD_EVENTS = 1000;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  op TEXT NOT NULL CHECK (op IN ('create','pause','resume','remove','run','compact')),
  args TEXT NOT NULL,
  session TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  at TEXT,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  busy TEXT NOT NULL CHECK (busy IN ('skip','force')),
  state TEXT NOT NULL CHECK (state IN ('active','paused','done','removed')),
  last_status TEXT CHECK (last_status IN ('ok','fail','skip')),
  last_ts TEXT,
  last_exit INTEGER,
  created_seq INTEGER NOT NULL REFERENCES events(seq),
  updated_seq INTEGER NOT NULL REFERENCES events(seq)
);
`;

// ---- paths and keys ----

export function cwdHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

export function storePathFor(home: string, scope: Scope, cwd?: string): string {
  if (scope === "global") return join(home, "global.sqlite");
  return join(home, `${cwdHash(cwd ?? process.cwd())}.sqlite`);
}

const HASH_RE = /^[0-9a-f]{12}$/;
const ID_RE = /^j\d+$/;

export function keyOf(parts: {
  scope: Scope;
  hash?: string;
  id: string;
}): string {
  if (parts.scope === "global") return parts.id;
  if (!parts.hash || !HASH_RE.test(parts.hash))
    throw new Error(`key: cwd scope needs a 12-hex hash, got '${parts.hash}'`);
  return `cwd-${parts.hash}:${parts.id}`;
}

export function parseKey(key: string): {
  scope: Scope;
  hash: string | null;
  id: string;
} {
  const m = /^(?:cwd-([0-9a-f]{12}):(j\d+)|(j\d+))$/.exec(key);
  if (!m)
    throw new Error(
      `key: cannot parse '${key}' (want j<n> or cwd-<12hex>:j<n>)`,
    );
  if (m[2]) return { scope: "cwd", hash: m[1], id: m[2] };
  return { scope: "global", hash: null, id: m[3] };
}

// ---- replay ----

export function replayJobs(db: DatabaseSync): Map<string, StoredJob> {
  const map = new Map<string, StoredJob>();
  const events = db
    .prepare("SELECT seq, ts, op, args, session FROM events ORDER BY seq")
    .all() as {
    seq: number;
    ts: string;
    op: string;
    args: string;
    session: string | null;
  }[];
  for (const ev of events) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(ev.args) as Record<string, unknown>;
    } catch {
      continue; // corrupt row: skip, never fatal
    }
    applyEvent(map, ev.seq, ev.ts, ev.op as Op, args);
  }
  return map;
}

export function applyEvent(
  map: Map<string, StoredJob>,
  seq: number,
  ts: string,
  op: Op,
  args: Record<string, unknown>,
): void {
  if (op === "create") {
    const a = args as unknown as CreateArgs;
    if (!a.name) return;
    // duplicate name among LIVE jobs: first wins (core refuses anyway);
    // removed names are recreatable - audit separation flows from ids
    for (const t of map.values()) if (t.state !== "removed" && t.name === a.name) return;
    const id = mintId(map);
    map.set(id, {
      id,
      name: a.name,
      prompt: String(a.prompt ?? ""),
      cron: String(a.cron ?? ""),
      at: a.at ?? null,
      cwd: String(a.cwd ?? ""),
      model: String(a.model ?? ""),
      busy: a.busy === "force" ? "force" : "skip",
      state: "active",
      created_seq: seq,
      updated_seq: seq,
      lastStatus: null,
      lastTs: null,
      lastExit: null,
    });
    return;
  }
  if (op === "compact") {
    applyCompact(map, seq, args as unknown as CompactArgs);
    return;
  }
  const id = typeof (args as IdArgs).id === "string" ? (args as IdArgs).id : "";
  const t = map.get(id);
  if (!t) return; // unknown id: no-op on replay
  if (op === "pause" && t.state === "active") {
    t.state = "paused";
    t.updated_seq = seq;
  } else if (op === "resume" && t.state === "paused") {
    t.state = "active";
    t.updated_seq = seq;
  } else if (op === "remove" && t.state !== "removed") {
    t.state = "removed";
    t.updated_seq = seq;
  } else if (op === "run") {
    const r = args as unknown as RunArgs;
    t.lastStatus = r.status;
    t.lastTs = ts;
    t.lastExit = r.exit ?? null;
    t.updated_seq = seq;
  }
}

function applyCompact(
  map: Map<string, StoredJob>,
  seq: number,
  args: { jobs?: unknown },
): void {
  map.clear();
  const raw = Array.isArray(args.jobs) ? args.jobs : [];
  for (const entry of raw) {
    const r = entry as Partial<StoredJob>;
    if (typeof r?.id !== "string" || typeof r?.name !== "string") continue;
    const state = (["active", "paused", "done", "removed"] as const).find(
      (s) => s === r.state,
    );
    if (!state) continue;
    map.set(r.id, {
      id: r.id,
      name: r.name,
      prompt: typeof r.prompt === "string" ? r.prompt : "",
      cron: typeof r.cron === "string" ? r.cron : "",
      at: typeof r.at === "string" ? r.at : null,
      cwd: typeof r.cwd === "string" ? r.cwd : "",
      model: typeof r.model === "string" ? r.model : "",
      busy: r.busy === "force" ? "force" : "skip",
      state,
      created_seq: seq,
      updated_seq: seq,
      lastStatus:
        r.lastStatus === "ok" ||
        r.lastStatus === "fail" ||
        r.lastStatus === "skip"
          ? r.lastStatus
          : null,
      lastTs: typeof r.lastTs === "string" ? r.lastTs : null,
      lastExit: typeof r.lastExit === "number" ? r.lastExit : null,
    });
  }
}

export function persistJobs(
  db: DatabaseSync,
  map: Map<string, StoredJob>,
): void {
  db.exec("DELETE FROM jobs");
  const insert = db.prepare(
    `INSERT INTO jobs (id, name, prompt, cron, at, cwd, model, busy, state,
       last_status, last_ts, last_exit, created_seq, updated_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of map.values()) {
    insert.run(
      t.id,
      t.name,
      t.prompt,
      t.cron,
      t.at,
      t.cwd,
      t.model,
      t.busy,
      t.state,
      t.lastStatus,
      t.lastTs,
      t.lastExit,
      t.created_seq,
      t.updated_seq,
    );
  }
}

// ---- event log ----

export function mintId(map: Map<string, StoredJob>): string {
  let max = 0;
  for (const t of map.values()) {
    const m = /^j(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `j${max + 1}`;
}

export function appendEvent(
  db: DatabaseSync,
  op: Op,
  args: Record<string, unknown>,
  session: string | null,
): number {
  const res = db
    .prepare("INSERT INTO events (op, args, session) VALUES (?, ?, ?)")
    .run(op, JSON.stringify(args), session);
  return Number(res.lastInsertRowid);
}

/** Compact when the log crossed the threshold (called before a mutation).
 * The snapshot is the FULL job state, tombstones included. Returns whether it
 * compacted. Run history older than the snapshot is dropped by design. */
export function compactIfNeeded(
  db: DatabaseSync,
  map: Map<string, StoredJob>,
  session: string | null,
): boolean {
  const count = db.prepare("SELECT COUNT(*) AS c FROM events").get() as {
    c: number;
  };
  if (count.c < COMPACT_THRESHOLD_EVENTS) return false;
  const snapshot: StoredJob[] = [...map.values()];
  const seq = appendEvent(db, "compact", { jobs: snapshot }, session);
  for (const t of map.values()) {
    t.created_seq = seq;
    t.updated_seq = seq;
  }
  persistJobs(db, map); // projection first: its seq refs must survive the delete
  db.prepare("DELETE FROM events WHERE seq < ?").run(seq);
  return true;
}
