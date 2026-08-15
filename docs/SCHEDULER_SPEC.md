# scheduler: design proposal

Background jobs from inside pi. Cron-backed, worker-GPU-bound, detached from
the session that created them. Not subagents: subagents are synchronous
children of a session; scheduler jobs survive session death and recur.

Prior art, read first: `/home/ng/Projects/make-money/watchdog.sh` and its
crontab line (`0 */4 * * * bash watchdog.sh >> watchdog-run.log`). An agent
hand-built this pattern: cron -> env setup -> health snapshot -> `pi -p`
headless -> bounded actions -> journal -> commit. Scheduler productizes it.

## decisions

- **pi is the job runtime.** A job = a crontab entry firing
  `pi -p "<prompt>" --model <model>` headless. No daemon, no new runtime.
  Default model `qwen3.8-workers` (the pool coexists with the brain in
  llama-swap's qwen38-split group, so jobs never evict the main session).
- **own store, not todo.** todo is session-scoped working state; "done" is
  meaningless for a recurring job. scheduler gets its own sqlite (jobs +
  run history), minted ids (j1, j2...), same event-log discipline as todo.
- **crontab is the source of scheduling truth.** One tagged line per job:
  `# pane-scheduler:j3` marker comment on the line. create/remove/pause
  rewrite only lines carrying the marker; everything else in the user's
  crontab is untouchable. `crontab -l | crontab -` round-trip, atomic.
- **every run is wrapped.** A small runner script (shipped in the package,
  invoked by the cron line) does: source `~/.pi/cron-env` if present, flock
  per job id (no overlapping fires; skip if held), busy-policy check, run
  `pi -p`, capture exit + duration, append run record, write log to
  `~/.pi/agent/scheduler/runs/<id>/<ts>.log`, prune old logs (keep ~20).
- **busy policy per job: skip | force (default skip).** Before running,
  query llama-swap `GET /running`. If the worker model's group is not
  resident and something else is (deepriver spans both GPUs), `skip` logs
  and exits 0. `force` runs anyway and eats the eviction. A missed
  5-minute tick is cheap; reloading a 90GB model mid-session is not.
- **report-back channel is rem.** The runner appends a standing instruction
  to the job prompt: reflect findings to rem (project-scoped to the job's
  cwd). The interactive session recalls them. No new IPC.
- **cwd per job.** Jobs store and run in an explicit cwd (default: cwd of
  the creating session). AGENTS.md, todo store, and rem scope follow from
  it, same as any pi session.

## tool surface

- `create {name, prompt, cron, cwd?, model?, busy?}` -> minted id. Validate
  cron expr (5 fields) before writing; refuse duplicates by name.
- `list` -> id, name, cron, state, last run (ok/fail/skip + ts), next fire.
- `pause {id}` / `resume {id}` -> comment/uncomment the crontab line, state
  in store follows.
- `remove {id}` -> delete crontab line + store row; run logs kept.
- `runs {id, n?}` -> last n run records with log tails.
- One-shot jobs: `cron: "once"` + `at: <ISO>` translates to an `at(1)`-style
  self-removing entry, or a cron line the runner deletes after first run.
  Implementer's choice; document it.

## rendering

Flat, render-kit vocabulary: `○` scheduled, `◐` running (flock held),
`●` last run ok, `✕` last run failed, paused rows dim. `list` renders like
the todo queue; `runs` uses head/tail previews.

## guardrails

- Loud errors: invalid cron, missing crontab binary, flock contention,
  pi exit != 0 all land in the run record and render as `✕` with the tail.
- The runner never inherits the interactive session's env beyond cron-env;
  jobs are reproducible from a cold shell (the watchdog's PATH lesson).
- promptGuidelines (terse, house style): background/recurring work ->
  scheduler, not a subagent and not a todo; one job per concern; jobs
  report via rem, check `runs` before re-creating a failing job.

## non-goals

- No coupling to todo (no schedule field there).
- No daemon, no queue server, no job dependencies, no retry policies v1.
- No root crontab, no system units. User crontab only.

## test plan (sketch, implementer refines)

- Store: create/list/pause/resume/remove round-trips, minted ids, event log.
- Crontab: tagged-line rewrite is surgical (foreign lines byte-identical
  before/after), pause comments correctly, remove leaves no trace.
- Runner: flock skip on contention, busy-policy skip vs force (fake
  /running), log written + pruned, run record on pi failure.
- Cron validation: rejects 6-field/garbage, accepts standard exprs.
- No live cron in tests: runner invoked directly; crontab mutations against
  a fixture via `crontab` on a temp spool or injected command shim.
