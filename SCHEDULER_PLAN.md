# scheduler: implementation plan

Implements `docs/SCHEDULER_SPEC.md`. The spec is the design; this file records
the decisions the spec left open (implementer's choice) plus one extension the
user directed: **two scopes, global (user-level) and per-cwd**.

## A. Scope model: global + per-cwd stores

- Two sqlite files, one per scope: `~/.pi/agent/scheduler/global.sqlite` (user
  level) and `~/.pi/agent/scheduler/<hash>.sqlite` (per job cwd, same
  sha1(cwd)-12 scheme as todo). Job identity is (scope, id); ids `j1, j2, ...`
  are minted per store and never reused (max-id scan includes tombstones).
- `create` takes `scope: "global" | "cwd"` (default `cwd`). Id-only actions
  (`pause/resume/remove/runs`) take an optional `scope`; when absent the id is
  resolved across the two stores: unique match wins, present in both refuses
  with a scope hint, absent from both refuses loudly. `list` renders both
  scopes in two labeled sections (global, this directory).
- The job's `cwd` (where `pi` runs) is an explicit parameter, defaulting to the
  creating session's cwd, and is independent of scope: a global job can run in
  any directory; a cwd-scoped job may run in a different directory than its
  store (the store is keyed by the scope cwd, the job by its own).

## B. Crontab: tagged lines, surgical rewrites, crontab-first

- One line per job: `<cron> <runnerPath> <key>  # pane-scheduler:<key>` where
  key = `j<n>` (global) or `cwd-<hash>:j<n>` (cwd scope; hash of the job's
  store cwd). The trailing tag is the only find marker; the runner gets the
  key via argv.
- Pause = prefix the line with `# ` (crontab then ignores it, tag stays
  greppable); resume strips exactly that prefix. Remove deletes the line
  (active or paused) and leaves no trace. Rewrites only touch lines carrying a
  pane-scheduler tag; every other byte passes through the round-trip.
- Ordering: the crontab is written **before** the store commit, for all four
  mutating actions. A failed store commit then leaves visible drift (a line
  with no row, or a row with no line) that `list` flags; a silent
  never-firing job is the outcome we refuse. `list` checks each non-removed
  job: line present with matching cron fields (active uncommented, paused
  commented); mismatches render a `drift` note.
- Empty crontab (`crontab -l` exit 1, "no crontab for") reads as `""`. Missing
  `crontab` binary fails loudly at action time.

## C. Cron expression: 5 fields, vixie semantics

- Fields: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7 (0 and 7 are
  Sunday). Items: `N`, `A-B` (A<=B, no wrap), `*`; comma lists; `/S` step on
  any form (S>=1). No names, no `@`-macros, no seconds: rejected loudly with
  the offending field.
- dom/dow union follows vixie cron: if both fields are restricted (not `*`), a
  day matches when **either** matches; if one is `*` only the restricted one
  governs. Documented in code and tested by name.
- `nextFire(expr, from)`: expand fields to value sets, scan forward by day up
  to 4 years, pick the smallest allowed hour (first day: not before `from`)
  then smallest allowed minute. No day matches within 4 years (e.g. `0 0 30 2 *`)
  returns null, rendered `never`.

## D. Once jobs: cron line the runner consumes

- Chosen over `at(1)`: no daemon, no extra binary. `cron: "once"` + `at: <ISO>`
  translates to the cron fields of that minute (`M H D Mo *`) and stores
  `once` + `at` on the job.
- The runner consumes on first fire: run pi, append the run record, delete the
  crontab line, mark the job `done`. No retries (v1): a failed once job is
  done-with-fail; re-create to retry. A fire after the job is already `done`
  (crash between run and line-delete) self-deletes the line and records a
  skip. All of this is in the README.

## E. Runner: thin sh + mjs engine, DI seams, deployed

- Two shipped files, deployed to `~/.pi/agent/scheduler/` on extension load
  (overwrite-when-changed, never block load). `runner.sh` (/bin/sh, ~20 lines):
  baseline PATH, source `~/.pi/cron-env` if present, `flock -n` on
  `locks/<key>.lock` (held: record skip, exit 0), exec `runner.mjs <key>`.
  `runner.mjs` (node ESM, zero package deps): store lookup, busy check, pi
  spawn, log capture, prune, run record, once/zombie self-heal.
- Cold-shell rule (the watchdog PATH lesson): runner.sh sets
  `PATH=$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`
  before anything runs; `~/.pi/cron-env` is sourced after and can extend it.
  No other interactive env is inherited. `pi` must resolve from that PATH.
- Busy check (llama-swap): normalize model names through `GET /v1/models`
  (id + `meta.llamaswap.aliases`; the store keeps pi catalog ids like
  `qwen3.8-workers` while `/running` reports canonical names like
  `qwen3.8-27b-workers`), then: own model resident -> run; nothing resident ->
  run; something else resident -> `skip` records + exit 0 or `force` runs and
  eats the eviction. Fetch failure -> skip (fail closed: a missed 5-minute
  tick is cheap, a 90GB eviction mid-session is not), with the reason in the
  record.
- The job prompt gets a standing report-back paragraph appended (findings to
  rem, project scope = job cwd). The command is
  `pi -p <prompt> --model <model> --no-session` run with cwd = job cwd, argv
  (never a shell string). Output tees to `runs/<scope-dir>/<id>/<ts>.log`,
  keep newest 20, prune by name. Run record = store event `op: "run"`,
  session NULL, args `{id, status, exit, durationMs, log, reason?}`.
- DI seams (constructor options, production defaults wired once):
  `{ home, crontab, fetch, spawn, now }`. Tests inject an in-memory crontab,
  fake fetch, stub spawn, pinned clock. No live cron, no network, no real pi
  in tests; runner.sh gets one real subshell test (flock contention) with a
  scrubbed env.

## F. Store: same event-log discipline as todo, plus tombstones

- Tables: `events (seq, ts, op, args, session)` + `jobs (id, name UNIQUE,
prompt, cron, at, once, cwd, model, busy, state, last_status, last_ts,
last_exit, created_seq, updated_seq)`. state CHECK `active|paused|done|removed`.
- Ops: `create | pause | resume | remove | run | compact`. Replay rebuilds the
  projection; removed jobs stay as tombstones so ids are never reused, `runs`
  works after remove, and remove survives compaction.
- Compaction (todo threshold, 1000 events, on mutation): a full jobs snapshot
  **including tombstones** replaces history. Run history older than the
  snapshot is dropped by design; `runs {id, n}` reads recent run events.
- The last_* projection columns update on every `run` event during replay.

## G. Tool surface

- Actions: `create {name, prompt, cron | (once + at), cwd?, model?, busy?,
scope?}`, `list`, `pause {id, scope?}`, `resume {id, scope?}`,
  `remove {id, scope?}`, `runs {id, scope?, n?}`. Defaults: model
  `qwen3.8-workers` (llama-swap alias, in pi's models.json), busy `skip`,
  scope `cwd`, cwd = session cwd, n = 5.
- Cross-field validation is runtime-loud (todo precedent): create requires
  name+prompt+cron (once additionally at, parseable ISO); verbs require id;
  duplicate name per scope refuses; cron validated before anything is written.
- Rendering (render kit vocabulary): list rows `glyph id name cron next-fire`,
  glyph = `◐` lock held, else `●` last ok, `✕` last fail, `○` never run; paused
  rows dim; two sections. `runs` uses head/tail previews (keep = tail).
- promptGuidelines (house style): background/recurring work -> scheduler, not
  a subagent and not a todo; one job per concern; jobs report via rem; check
  `runs` before re-creating a failing job.

## Non-goals (per spec)

No todo coupling, no daemon, no dependencies between jobs, no retry policies,
no root crontab/system units, no month/day names in cron v1.

## Test plan (refines the spec sketch)

- cron: accept/reject by boundary name (59/60, dom 31/32, month 12/13,
  dow 7/8, `*/0`, wrap ranges, lists, 4/6 fields, `@`-macros, garbage);
  nextFire exact (leap Feb 29, dom/dow union, first-day hour boundary, never).
- crontab: foreign lines (ENV, comments, blanks, unrelated jobs)
  byte-identical through create/pause/resume/remove; tag find; empty crontab;
  missing binary loud; paused format round-trips.
- store: round-trips; minting without reuse after remove; per-scope isolation;
  one event per mutation; run events; compaction keeps tombstones; corrupt
  reads empty.
- core: drift detection (both directions); ambiguous id across scopes refuses;
  duplicate name per scope refuses; crontab-first ordering (store failure leaves
  the crontab change, not vice versa).
- runner: flock held -> skip; busy matrix (resident / nothing / other, skip vs
  force, fetch failure -> skip); alias normalization; log written + pruned to
  20; pi exit != 0 -> fail record with exit + duration; once -> line removed +
  done; zombie self-heal (missing/done row with live line); cold shell (scrubbed
  env) via runner.sh; report-back instruction present in the spawn argv.
