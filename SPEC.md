# SPEC: todo v2 — task tracking without losing the queue

Status: implemented (TDD, clean break). 119/119 tests green. Implementation: extensions/todo.ts v2 + extensions/**tests**/todo.test.mjs. See git diff; review before commit. Companion to README.md (philosophy) and AGENTS.md (contract).

## Problem

The todo tool is scope containment, not task tracking. Three gaps, observed live:

1. **No history.** `Task = {id, text, status}`. Transitions are destructive: `complete` erases the `in_progress` state, `fail` erases nothing but records nothing. A queue that dies mid-project leaves no trace of what was attempted, in which order, or where it stopped. Cross-session recovery is impossible by construction.
2. **Silent data loss on corruption.** `load()` returns `[]` on corrupt JSON. Fails open against the "fail closed on uncertain state" rule in AGENTS.md. A corrupt store reads as "no tasks", and the real queue is one write away from being overwritten.
3. **No presence.** The store persists per-cwd, but nothing surfaces it. Pending tasks from a dead session are invisible until an agent thinks to call `read`. Orphaned queues accumulate (observed: `/tmp` store, "failure mode test", pending since Aug 11).

## Goal

Evolve the queue into a replayable, auditable, fail-closed task tracker. Same 6 actions, same FSM, same API shape. The agent-visible surface does not change; the store underneath becomes a real relational database instead of a single mutable JSON file. Clean break: no migration from the legacy JSON store; a fresh sqlite database is authoritative.

## Design

### A. Database schema (the spine)

SQLite per workspace, via `node:sqlite` (`DatabaseSync`). Zero dependencies: built into Node >= 22.5, pi requires >= 22.19. Same per-workspace keying as today (`sha1(cwd)` prefix), file extension `.sqlite`. WAL journal mode + busy_timeout for cross-process safety.

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- meta: schema_version = 1, created_at

-- Append-only event log: the source of truth. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  op TEXT NOT NULL CHECK (op IN ('create', 'start', 'complete', 'fail', 'retry')),
  args TEXT NOT NULL,          -- JSON: {tasks: [...]} for create, {id} for verbs
  session TEXT                 -- session id, best-effort attribution (NULL for now)
);

-- Projection: materialized queue state, rebuilt by replay on every call. Disposable.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,         -- minted "tN" per workspace, as today
  text TEXT NOT NULL UNIQUE,   -- natural key for idempotent create (upsert)
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  pos INTEGER NOT NULL,        -- queue position = priority; minted, never mutated in place
  created_seq INTEGER NOT NULL REFERENCES events(seq),
  updated_seq INTEGER NOT NULL REFERENCES events(seq)
);

-- Ordering spine: (pos, created_seq) serves render order and next-pending deterministically.
-- (tasks has no bare seq column; created_seq anchors determinism for equal positions.)
CREATE INDEX IF NOT EXISTS tasks_pos_seq ON tasks (pos, created_seq);
```

Rules:

- Every call is one transaction: read the log, rebuild the projection, (append the event for a mutation), persist the projection. A torn write cannot desync log from projection because the projection is _always_ rebuilt from the log; it is never trusted.
- `read` appends no events. It rebuilds + persists the projection and renders from it.
- Replay is total: it never throws. A corrupt args JSON or an inapplicable transition (e.g. `complete` on an unknown id) is skipped, never fatal. The log is the spine; one bad row cannot invalidate the queue.
- `events` is append-only by construction: `UPDATE`/`DELETE` on events are forbidden by the tool. Compaction is a future story.
- **Position is minted, never mutable state.** On create, new texts get the next free positions (after the current max); existing texts keep their position and status. On a fresh queue this equals the create array index. No reorder op exists; when one is added it must be a new event (`move`), not an in-place UPDATE.
- **Corruption fails closed.** Open + integrity check; on failure the database file is recreated empty (no crash, no partial queue). The queue is gone, honestly, not guessed. (Events live in the same file; a corrupt file means the log is unrecoverable.)

### B. Idempotent create (upsert by natural key)

`create` is upsert by `text` (the natural key), enforced by `tasks.text UNIQUE`:

- Incoming task whose `text` matches an existing row: keep that row entirely (id, status, position). No-op.
- New text: mint fresh id, insert as `pending` at the next free position.
- Replaying an identical create is a no-op: same texts, same ids, same positions, no duplicates. This is the AGENTS.md rule made literal: "writes are idempotent, pipelines replayable, dedup natural key".
- `create` with `tasks: []` clears the queue (the only destructive verb). Replay reproduces this deterministically.

### C. Stale-task surfacing (presence, minimal)

`read` and every mutation reply append a one-line footer when the workspace has unresolved history:

```
· 1 unresolved since 2026-08-11 (recovered from log)
```

Trigger: a `pending` or `in_progress` task whose `updated_seq` is older than `STALE_THRESHOLD_SEQ` events behind the latest seq. Threshold constant exported from the module (`STALE_THRESHOLD_SEQ = 200`, approximating 24h of activity); deterministic, boundary-testable, no wall-clock sleeps.

```sql
SELECT t.id, t.text, t.status, e.ts AS updated_ts
FROM tasks t JOIN events e ON e.seq = t.updated_seq
WHERE t.status IN ('pending', 'in_progress')
  AND t.updated_seq <= (SELECT MAX(seq) - :threshold FROM events);
```

Footer date = the most recent updated_ts among stale tasks; format `YYYY-MM-DD`. Footer omitted when everything is fresh or empty. No new tool, no prompt injection.

Scope: this is the cheapest honest version of "startup presence". A future footer hook may surface counts, but that is out of scope here.

### D. Concurrency semantics

- In-process: unchanged. `withLog` still serializes call order; tests stay scheduled, not slept.
- Cross-process: WAL + busy_timeout serialize writers at the database level. Last-writer-wins remains (documented), but it is now _detectable_: the events log records both writers in commit order. Race analysis = replay the log, not guess from a single JSON file.
- The FSM checks run inside the transaction, against the freshly rebuilt projection. Same refusal strings, same semantics.

### E. Explicitly out of scope

- Dependencies (`dependsOn`), priorities, due dates, estimates. `next` stays "first pending". Schema creep rejected.
- Cross-process CAS/ownership (`owner: sessionId`). LWW stays, but now detectable via the log instead of silent. Ownership is a future spec.
- Automatic startup injection into the system prompt. The reply-footer surfacing (C) is the minimal version.
- Event log compaction. Events grow unbounded by design; the log is the recovery + audit spine. Compaction is a future story.
- Migration from the legacy JSON store. Clean break; the legacy file is simply never read again.

## Compatibility

- All six actions, argument names, FSM transitions, render output, and error strings remain identical. The API-level behavioral tests are frozen.
- Store-shape tests change: `rawStore()` (JSON read) becomes sqlite queries. This is legitimate test evolution — the store is the thing changing — but the _behavioral_ contract is frozen.
- No legacy store support. A missing database is an empty queue, by design.
- Concurrency semantics preserved; races become detectable rather than silent.

## Testing strategy (TDD)

1. **Schema + integrity** — open creates tables + meta version; reopen is idempotent; corrupt database file is recreated empty without crashing.
2. **Event log invariants** — each mutation appends exactly one event row with correct op/args; read appends nothing; seq strictly increases.
3. **Projection self-heal** — direct tampering with a task row is corrected by the next read (projection is rebuilt from events, never trusted).
4. **Atomicity** — projection and event log are always consistent: updated_seq points at the last event for the task.
5. **Idempotent create** — replaying create with identical texts does not duplicate ids; upsert preserves status and position; new texts mint at next positions; explicit clear still empties.
6. **Stale surfacing** — pending/in_progress older than the seq threshold appends the footer; fresh queues omit it; boundary via synthetic events, not sleeps.
7. **Regression** — the full suite (`node --test extensions/__tests__/*.test.mjs`) stays green.

## Success criteria

- Full suite green. API-level behavioral tests unmodified in semantics.
- No agent-visible API change: same tool name, actions, FSM, renders, errors.
- Corruption cannot lose data silently: integrity failure recreates the store empty; the projection can never drift from the log.
- Cross-session recovery is possible: replaying a workspace event log reconstructs the exact queue state.
- Zero new dependencies. `node:sqlite` is built into the Node version pi already requires.
