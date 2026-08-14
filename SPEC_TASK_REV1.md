# SPEC: todo rev 1 — dependsOn task trees

Status: implemented (TDD). Implementation: extensions/todo.ts + extensions/**tests**/todo.test.mjs. This closes the gap SPEC.md v2 explicitly deferred: "Dependencies (dependsOn), priorities, due dates, estimates. next stays 'first pending'. Schema creep rejected."

## Problem

The queue has no way to express prerequisite structure. "next" is the first pending task by position, so a task that cannot be completed until another task finishes is indistinguishable from one that is ready. There is no structural guard against nonsense graphs: self-dependencies, cycles, references to tasks that do not exist. Task trees cannot be created, and blocked work is invisible until a completion is refused.

## Goal

Add an optional `dependsOn` per task at create time, forming a task tree. The dependency graph must be a DAG: self-dependencies and cycles are refused loudly at the only mutation point (create). Completion of a task whose dependency is not `done` is refused loudly with the blocker and its status. Renders and tool details expose the graph honestly: blocked tasks are annotated, "next" skips them. Same six actions, same FSM otherwise, same event-log spine, zero new dependencies.

## Design

### A. Schema

Clean break, no migration (per review: no relevant local stores). The `tasks` projection gains a column; the `events` table is unchanged (create args carry the dependency).

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  depends_on TEXT,              -- task id this task depends on, or NULL
  pos INTEGER NOT NULL,
  created_seq INTEGER NOT NULL REFERENCES events(seq),
  updated_seq INTEGER NOT NULL REFERENCES events(seq)
);
```

`depends_on` references `tasks.id` by convention, not by foreign key: the projection is disposable and rebuilt from events on every call, so code validation is the guard. Existing v2 stores fail loudly on the first write (`no such column: depends_on`); delete the store file to recreate. That is the honest clean break, matching v2's precedent with the legacy JSON store.

The event log stores the create input as given (raw `dependsOn` value, id or text, or `null`). The projection resolves it to a minted id. Replay re-resolves deterministically through the same pure planning function, so log fidelity and projection determinism are both preserved; the log records intent, the projection records canonical state.

### B. API contract

`create` task items gain an optional `dependsOn` field:

- `string`: an existing task id (`"t3"`) or an exact task text (`"A"`). Existing ids resolve id-first; batch-internal references resolve by text only (a minted id cannot be known in advance, and an id-first rule would shadow a task whose text looks like an id with the caller's own fresh id).
- `null`: clear the dependency.
- omitted: keep the row entirely (v2 no-op preserved).

Same-batch references work in any position: a task may depend on a task created earlier or later in the same create call, always by text. References to tasks outside the batch resolve against the existing queue by id or text.

Upsert semantics extended:

- dependsOn omitted on a recreate: no-op, the link is kept.
- dependsOn provided on a recreate: the link is updated. Create is the only dependency mutation point; there is no unlink action.
- dependsOn `null` on a recreate: the link is cleared.
- first occurrence wins within a batch; duplicate texts are ignored entirely.

### C. DAG enforcement (validation at the boundary)

Create is the only place the graph can change, so validation lives entirely there, inside the transaction, before the event is appended. Pure planning (`planCreate`) dedups, mints ids, and resolves dependencies against existing tasks plus the batch itself. Problems are collected, never thrown:

- `dependsOn 'X' not found` — target does not exist as id or text
- `'A' cannot depend on itself`

A pure DFS (`cycleProblem`) runs over the existing graph plus the planned batch. A back edge yields the cycle path, refused loudly:

- `dependencies would form a cycle: t2 -> t1 -> t2`

Any problem rejects the whole batch: nothing is created, no event is appended, the transaction rolls back. No partial trees, no silent drops.

Replay is total and never validates: it applies plans best-effort. A dangling target from a corrupt or hand-edited event is dropped at apply time (link becomes NULL), never a crash and never a deadlocked task. A self-link from a corrupt log is kept as-is; it is honest, unreachable state.

### D. Completion gating

Dependency gates completion, not commencement:

- `start` on a blocked task is legal: preparation work can proceed while the dependency is in flight.
- `complete` on a blocked task is refused after the task's own FSM checks (existing error strings unchanged). The refusal names the blocker and its status, per-status:

  - `'B' is blocked by 'A' (pending; start it first)`
  - `'B' is blocked by 'A' (in_progress)`
  - `'B' is blocked by 'A' (failed; retry it first)`

- `fail` on B is unaffected: B's own failure is recordable regardless of its dependencies.
- A failed dependency blocks until it is retried and completed; no special casing.

The graph is immutable after create (no unlink action), so the acyclic invariant holds for the queue's lifetime once enforced at create.

### E. Render and presence

The public `Task` shape gains two fields, both derived at reply time:

- `dependsOn: string | null` — the resolved dependency id, from the projection.
- `blockedBy: string | null` — the dependency id when this pending/in_progress task's dependency is not `done`; `null` for done/failed tasks.

Renders:

- "next" skips blocked pending tasks (first unblocked pending; a queue whose pendings are all blocked shows counts only).
- pending/in_progress rows whose dependency is unsatisfied get a dim ` · waits on tN` suffix in both render paths (tool reply and TUI queue).
- No tree indentation: `pos` remains flat queue order. The tree is the dependency graph, not the layout.

### F. Out of scope

- Multiple dependencies per task (the column is singular; multi-parent requires a child table).
- Unlink/reorder actions (recreate with `dependsOn: null` is the unlink).
- Tree indentation and dependency-aware reordering in render.
- Auto-start or auto-fail propagation to dependents.
- Dependency awareness in the stale footer.

## Compatibility

- All six actions, argument names, FSM transitions, and existing error strings remain identical.
- The create payload is additive (`tasks[].dependsOn`); schema validation rejects non-string/non-null values.
- The event log is additive: create args may carry `dependsOn`; replay is tolerant of absent and unresolvable refs.
- Behavior for queues without dependencies is byte-identical: omitted dependsOn is a no-op, `next` and renders unchanged, `blockedBy` always null.
- The `tasks` table gains `depends_on`; old stores fail loudly and recreate on delete (clean break, no migration code).
- Legacy argument mapping (`{items}`) unchanged.
- Store-shape test evolution: `projRows` SELECT gains `depends_on`; existing assertions on task rows are untouched.

## Testing strategy (TDD)

Failing tests first, per group, against the real sqlite store and tool:

1. **Schema** — dependsOn accepted as id/text/null/omitted; non-string values rejected.
2. **Tree creation** — same-batch chain and diamond accepted; depends_on persisted; forward references within a batch resolve.
3. **Resolution** — by id, by text, id-wins precedence; unknown target refused loudly with the batch rejected atomically (no event appended, queue unchanged).
4. **Validation** — self-dependency refused; 2-node and 3-node cycles refused with the cycle path; an existing acyclic queue cannot be pushed into a cycle by a recreate.
5. **Upsert semantics** — omitted keeps the link; provided updates it; null clears it; first occurrence wins.
6. **Completion gating** — blocked complete refused per dependency status; unblocked complete works; start on a blocked task is legal; retry-fail cycle unblocks; done tasks never report a blocker.
7. **Presence** — next skips blocked tasks; waits-on suffix; blockedBy in details; non-dependency queues show neither.
8. **Replay integrity** — dependencies survive projection tamper (rebuilt from events); a dangling ref from a corrupt create event drops on replay and the dependent unblocks.
9. **Event log** — create event args carry dependsOn as given; every mutation appends exactly one event; read appends nothing.
10. **Regression** — the full suite (`node --test extensions/__tests__/*.test.mjs`) stays green; all existing todo tests pass unmodified except the `projRows` SELECT.

## Success criteria

- Full suite green; every existing todo test passes unmodified in semantics.
- A task tree can be created in one call, completed only in dependency order, and refused loudly with teachable messages otherwise.
- The graph is fully reconstructable from the event log alone; replay never crashes on corrupt refs.
- Zero new dependencies; `node:sqlite` only.
