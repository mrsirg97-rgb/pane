# SPEC: rem v1 — a memory tool for the pi harness

Status: proposal, amended per review, pending final approval. Implementation target: extensions/rem.ts + extensions/__tests__/rem.test.mjs, TDD. Design draws on the concepts in ~/Projects/lift/cmd/rem (recall fusion, consolidation arithmetic, idempotent writes), translated to SQLite and trimmed to a native pi tool.

## Problem

The agent has no memory across sessions. Each session starts from nothing: the same debugging epiphany, the same constraint, the same fixed approach are re-derived every time. Files encode what was *done*, not what was *learned*. What is missing is a tool that commits facts and constraints durably, recalls past solutions on intent, distills long sessions into compact memories, and degrades gracefully as memories age.

The heavy machinery already exists (lift/rem: sources, episodes, associations, MCP). A native pi tool does not need that surface. Four operations, SQLite backend, same extension patterns as todo.ts.

## Goal

A four-operation memory tool registered as the `rem` tool:

- `learn` — write: commit a fact or constraint, idempotently, with provenance.
- `recall` — read: fuzzy/semantic search over memories on intent; project-scoped first, global fill.
- `reflect` — write: store a distilled memory with the raw source log it came from; automatic on session compaction.
- `prune` — write: consolidate the strength arithmetic, remove or reduce memories.

Same conventions as todo.ts: node:sqlite DatabaseSync, fail-closed open, serialized access, WAL checkpoint on close, schema-level guards, terse renders. Real programs over mocks; the behavioral suite exercises the real sqlite store.

## Step zero: FTS5 spike (done)

The semantic arm rests on Node's bundled SQLite being compiled with FTS5. Verified on the target build before any code: `CREATE VIRTUAL TABLE m USING fts5(content)` succeeds on SQLite 3.51.3 (Node 22.23.2), and `tokenize='porter unicode61'` provides Porter stemming, including inside quoted phrases. `ORDER BY rank ASC` orders best-first (bm25 rank is negative).

Portability: FTS5 is compiled in on mainstream Node builds, but not guaranteed on every platform. FTS availability is detected per connection — the guarded `CREATE VIRTUAL TABLE` is the probe — and the result rides the open handle in memory only. It is build state, never persisted: a stale meta value cannot outlive an open or survive a Node upgrade. The semantic arm is gated on the per-open flag, and the FTS insert on `learn`/`reflect` is gated too, so an fts-less build never queries or writes a table it could not create. The acceptance suite simulates the absence path through a test seam (`__setFtsAvailable`) and asserts fuzzy-only recall still serves and learns still land.

## Design

### A. Shared sqlite.ts — pending, not shipped

todo.ts and rem.ts need identical fail-closed machinery (open-with-integrity-check, recreate-on-corruption, WAL checkpoint + close, serialized access queue). This version ships with todo.ts untouched and rem.ts self-contained: rem carries its own `openStore`/`withLog`/`withStore` copies, mirroring todo's patterns. The `extensions/sqlite.ts` extraction remains a follow-up refactor; it must parameterize the corruption policy, because the two stores diverge deliberately: todo deletes a corrupt queue (short-lived), rem quarantines it (memories are irreplaceable evidence). That divergence is a documented parameter, not drift.

### B. Store topology — hybrid, single file

One store file: `~/.pi/agent/rem/rem.sqlite`. Memories carry a `scope` column: `'global'` or the cwd short hash. This is the hybrid model: general knowledge is explicitly scoped `global`; everything else is project-scoped by the cwd at learn time.

Single file over per-scope files: one fail-closed path, one WAL, one schema version, and hybrid recall is a scope-priority query instead of a cross-database merge. The cost is that corruption-recreate nukes every scope; the quarantine policy (below) makes that cost nearly free. A `scope_label` column (cwd basename) exists for display only; scope keys stay internal.

### C. Corruption quarantine, not deletion

A corrupt store is renamed aside, never deleted:

`rem.sqlite` → `rem.sqlite.corrupt-<timestamp>` (same for `-wal`/`-shm`), then a fresh store is created in place. Still fail-closed, still no partial reads, but the evidence survives for manual recovery. Deleting is honest for a short-lived task queue; memories are long-lived and irreplaceable, so the file is evidence.

### D. Schema

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
); -- schema_version, created_at

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- AUTOINCREMENT: pruned ids are never reused
  scope TEXT NOT NULL CHECK (scope IN ('global') OR length(scope) = 12),
  scope_label TEXT NOT NULL,            -- cwd basename, display only
  kind TEXT NOT NULL DEFAULT 'fact',    -- free string: fact|constraint|solution|reflection|...
  content TEXT NOT NULL,
  source TEXT,                          -- provenance: log text, file path, session id
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  strength REAL NOT NULL CHECK (strength BETWEEN 0 AND 1),
  access_count INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_accessed_at TEXT,
  last_consolidated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  content_md5 TEXT NOT NULL             -- dedup key materialization
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_content ON memories (scope, content_md5);
CREATE INDEX IF NOT EXISTS memories_scope_created ON memories (scope, created_at);

-- fuzzy arm: per-word padded trigrams, the sqlite analogue of pg_trgm word_similarity
CREATE TABLE IF NOT EXISTS trigrams (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  gram TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trigrams_gram_idx ON trigrams (gram);
CREATE INDEX IF NOT EXISTS trigrams_memory_idx ON trigrams (memory_id);

-- semantic arm: full-text index, created guarded (see step zero)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
  content,
  tokenize = 'porter unicode61'
);
```

`PRAGMA foreign_keys = ON` per connection. Two correctness decisions, both load-bearing:

1. **AUTOINCREMENT, not bare `INTEGER PRIMARY KEY`.** SQLite reuses `max(rowid)+1` after the largest row is deleted. Prune removing a memory could make a dangling `superseded_by` silently re-point at an unrelated new memory. AUTOINCREMENT mints strictly increasing ids; pruned ids are never recycled, so supersession references are permanent.
2. **`ON DELETE SET NULL`, not CASCADE, not bare.** With `foreign_keys = ON`, deleting a memory others point at would loudly fail the whole prune. SET NULL means removing the superseding memory unsupersedes the older one, whose content is then the best surviving record. Supersession pins nothing; the refusal would force the agent to delete both memories to delete one, and would never be the right answer for prunable reflections.

Ids are integers, rendered as `mN` for the operator; parameters take the numeric id. Minted by the store; copy, never invent.

### E. FTS and trigram bookkeeping — pinned

The FTS table and trigram table are projections of `memories`, written in code in the same transaction, never by triggers: explicit, testable, unmissable.

- `memory_fts.rowid` = `memories.id` — the FTS row for memory `m42` lives at rowid 42. Insert copies the content at learn time (gated on the per-open FTS capability); prune removes `DELETE FROM memory_fts WHERE rowid = <id>`, the statement gated (prepare included) on the per-open FTS capability — node:sqlite validates schema at prepare time, so an fts-less build must not even compile the statement. A test asserts no orphaned FTS row survives a prune.
- Trigrams are written from per-word padded grams (pg_trgm convention: two-space padding), deduplicated per memory, and removed by the FK cascade (`ON DELETE CASCADE`) — plus an explicit delete for defense in depth; a test asserts no orphaned trigram rows survive a prune.
- The source column is never indexed; provenance is display-only.

### F. Recall: two arms, reciprocal rank fusion

`recall` is the read path and the only fuzzy path. Two lexical arms, fused by reciprocal rank (RRF, k = 60) exactly as lift does, then strength-blended and filtered:

1. **semantic arm** — FTS5 `porter unicode61`, query built as `token1 AND token2 ...` with reserved FTS tokens (`and`, `or`, `not`) quoted, ranked by `bm25` (`ORDER BY rank ASC`). Handles normal prose, stemming, multi-word intent.
2. **fuzzy arm** — trigram shadow table, per-word padded trigrams, scored by query-gram overlap with a minimum absolute overlap (3) and a minimum containment (0.5), the sqlite analogue of pg_trgm `word_similarity`. This is the arm that recovers identifiers, flags, error strings, hostnames that FTS mangles: `llamaswap` finds `llama-swap on :8090`, `UD IQ1S` finds `UD-IQ1_S`, `n-cpu-moe` finds `--n-cpu-moe 19 OOMs at depth`.

Per-arm ranking is a narrow indexed seek (FTS query, trigram IN-list); hits are deduped by memory_id; the fused rank feeds the strength blend `fused_rank x (floor + gain x effective_strength)`; superseded memories rank after live ones and are dropped unless `include_superseded` is set. `k` is a live-hit budget, capped at 50; each arm fetches at most `2k` to allow fusion. No query is a browse: latest by effective strength and recency.

Embeddings stay out: the semantic gap (synonymy, paraphrase) is an additive `memory_embedding` column later, the same decision lift made.

### G. Strength: effective strength at recall, checkpointed pass at prune

Decay must not depend on an op nobody triggers. Per review, the arithmetic is split:

- **Recall computes effective strength, never persists it.** For each candidate, effective strength = `clamp(reinforce(decay(stored_strength, days_since_last_consolidated_at), access_count, importance))`. The blend, the display, and browse ordering all use the effective value; `recall` touches only `access_count` and `last_accessed_at`. Strength degrades unconditionally with age, whether or not consolidate ever runs.
- **Self-supersession is a no-op.** Re-learning a memory with `supersedes` including its own id must not demote it; targets are filtered to other memories, missing targets refuse loudly (a typo must never silently corrupt the trust chain).

**`prune consolidate` persists the pass.** For every memory: `strength = consolidate(strength, days_since_last_consolidated_at, access_count, importance)`, then `last_consolidated_at = now` and `access_count = 0`. A replay with no elapsed time and no new accesses is a no-op (strength is already clamped in range), so the pass is idempotent by construction. Because recall's effective computation uses exactly the same inputs a checkpoint would, the two paths agree: effective-at-recall equals what consolidate would persist, and consolidating later cannot double-count.

Constants (named, one comment each): decay rate 0.02/day (half-life ~35 days), reinforce rate 0.05 per access scaled by importance, blend floor 0.4 / gain 0.6, RRF k 60, fuzzy minimum overlap 3, fuzzy minimum containment 0.5.

### H. Operations

| op | read/write | params | semantics |
|----|-----------|--------|-----------|
| `learn` | write | content*, kind?, importance?, scope? (project\|global), supersedes? (id\|ids) | idempotent on (scope, md5(content)); existing rows accept importance and supersedes updates, content unchanged; supersedes targets must exist, loud refusal otherwise |
| `recall` | read | query?, k?, scope? (project\|global\|all), kind?, include_superseded? | two-arm fusion, effective-strength blend, live-hit k budget; no query = browse; touches access counters only |
| `reflect` | write | content*, source?, scope?, importance? | stores the distilled memory with raw source for provenance; kind defaults to reflection; importance defaults lower (0.3) |
| `prune` | write | verb* (remove\|reduce\|consolidate), ids?, scope?, kind?, older_than_days?, importance? | consolidate = persisted arithmetic pass; remove/reduce need selection (ids or criteria), loud refusal otherwise; reduce requires a target importance |

Selection for remove/reduce is `ids` OR criteria (`scope`/`kind`/`older_than_days`); `remove` reports actual deletions, so missing ids report zero rather than phantom removals. `consolidate` honors the same optional selection and defaults to the whole store when none is given: a scoped request is honored, never silently widened. Cross-field requirements are runtime-loud, exactly the todo pattern: schema-optional fields, loud execute-time checks.

`reflect` does not summarize. The compression is the caller's: the agent reads a log (a session transcript, a pasted debugging session, pi's own compaction output) and calls reflect with the distilled memory and the raw source. The raw source rides the memory row, never indexed, shown only as provenance. Nothing is lost, nothing is secretly summarized.

`reflect` also runs automatically. The harness already compresses the write-ahead log of agent work on every compaction: a `session_compact` hook stores `event.compactionEntry.summary` as a low-importance reflection (0.2), scoped to `ctx.cwd`, deduplicated by content md5. No LLM call is made; pi's compaction summary already exists. The hook is fire-and-forget: a store failure must never crash a session.

### I. Tool surface

`registerTool` with the todo.ts shape: name `rem`, flat typebox schema, schema-optional + runtime-loud cross-field checks, `renderShell: "self"`, header + indented render via _render-kit, terse promptGuidelines (learn kinds are free strings, reuse labels; recall budget is a k cap; prune consolidate is the decay pass; ids are minted `mN`, copy never invent).

Reply details carry `{ action, memories }` so the model sees structured records; the rendered text is prose-free. Recall rows carry the reaching arm (`match: fts | fuzzy | both`) and effective strength.

## Rules

- Every call is one transaction: memory row + FTS row + trigram rows land atomically or not at all. A torn write cannot leave an index without its memory.
- `recall` appends no rows; it touches only access counters and never strength.
- Idempotent by natural key: learning the same content in the same scope twice is a no-op, never a duplicate.
- Fail closed on corruption: a store that fails to open or integrity-check is quarantined (renamed with a `.corrupt-<ts>` suffix) and recreated empty; the evidence file survives.
- Serialized access: concurrent calls land in call order against fresh state (withLog).
- Bounded work: k capped at 50, per-arm at 2k, trigram grams deduplicated, prune selection always bounded.
- Errors are loud and contain context; refusal messages teach the protocol.

## Scope

**in:** the four operations, two-arm recall, scope model (global + project hybrid), effective-strength arithmetic with checkpointed consolidate, supersession with SET NULL, corruption quarantine, FTS availability gate with fuzzy-only fallback, automatic session_compact reflection, behavioral suite on the real store, package.json registration, README mention.

**out:** shared sqlite.ts extraction (follow-up refactor, unifies todo + rem on the same lifecycle), embeddings/vector search, associations/graph recall, episodes, multi-user, automatic source indexing, migrations beyond CREATE IF NOT EXISTS.

## Acceptance (failure-mode-first tests)

Step-zero spike documented above (FTS5 verified on target build). Identifier-shaped corpus, lift style: `llamaswap` recalls `llama-swap on :8090 OOMs at depth`; `UD IQ1S` recalls `UD-IQ1_S quant of DeepSeek-V4-Flash`; `n-cpu-moe` recalls `--n-cpu-moe 19 OOMs at depth`. Superseded hits rank below live ones and carry `superseded_by`; removing the superseding memory unsupersedes the older (SET NULL); pruned ids are never reused (AUTOINCREMENT); a decayed memory loses to a fresh one even with consolidate never run (effective strength); recall does not persist strength; consolidate is idempotent and resets the checkpoint window; scope isolation and global-fill order; learn dedup and re-learn importance updates; missing supersedes target refuses loudly; corrupt store quarantines (`.corrupt-` file exists, store reads empty) and never crashes; FTS rows are removed by rowid on prune (no orphans, trigrams neither); an fts-less build disables only the semantic arm (per-open detection, test seam) and learns still land; prune remove on a genuinely fts-less store (table dropped, seam off) never prepares the FTS delete; concurrent mutation serialization; schema invalid shapes refuse at check or execute; reflect stores memory + source; session_compact hook stores a deduped reflection. The todo suite stays green (todo.ts untouched).
