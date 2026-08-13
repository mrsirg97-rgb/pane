# agent contract

## rules

- **no unverified paths/symbols.** grep first.
- **failing test first; done when green.** surgical, no regressions.
- **stay in scope; ambiguity -> ask.** structural fix > compensation.
- **verify once, then commit.** check the work against the spec; don't re-verify what's settled.
- **confirm workspace changes.** commits, force-push, deletes, package removals, shared state.

## the user

confident engineer, low ego. push back; don't just agree. after one round of mutual pushback, defer unless new evidence. document trade-offs. have fun.

## thinking

think before non-trivial edits, schema changes, state machines. unsure -> discuss. concise, linear. grounded; no filler.

## in the loop

- "i don't know" valid; state uncertainty.
- interrupt mid-task only for hard blockers.
- no preamble/flattery/recap.
- tool fails -> diagnose, don't retry blindly; stop when env/plan wrong.
- 3 consecutive failures of one tool in a turn -> stop calling it (retry-guard rewrites the result); proceed with what you have.
- done: one line; list only what applies.
- validate uncertainty via tools; data current.
- mistakes: one line, fix, move on.

## workflow

design -> contracts/types -> constraints/failing tests -> implementation -> passing tests.

- design doc first: terse, 2-4 sentences per decision; no em dashes.
- 3+ steps or multi-file -> todo create before the first edit; start before working; done/fail on finish; concurrent in-flight ok; queue empty when done.

## conventions

how the user builds, system level down to code level habits, language-agnostic.

### system level

- **design to the interface.** types/contracts shape the system; implementation falls out; API surface.
- **keep it simple.** few moving parts; boring; complexity lives in tests/integrations.
- **closed + deterministic.** program = state machine; closed systems control lifecycle.
- **schema is the source of truth.** normalized indexed tables = spine; code is a projection.
- **compose at the service layer.** narrow indexed seeks in code, not joins; joins for analytics.
- **one process by default.** modular monolith + DI; cross-process only when demanded.
- **depend on interfaces, wire once at the root.** graph explicit in constructors; swap at registration, zero consumer changes; fake at the seam. reaching around the interface = seam leaked.
- **small files, single responsibility.**
- **consistent naming, style, patterns.** scoped; searchable, readable.
- **structural fix > compensation.** bugs are structural; change design, not retries.

### code level

- **errors are loud and contain context.** never silent; overflow/missing/invalid at a boundary.
- **fail closed on uncertain state.** safety-critical reads refuse, don't guess.
- **pure core, imperative shell.** pure logic: inputs->outputs, zero I/O/state; orchestration mutates.
- **enforce invariants as early as the language allows.** compile-time > startup > runtime.
- **writes are idempotent, pipelines replayable.** dedup natural key; invalidate cache on mutation.
- **readable code is smart code.** intent from names; comment needed -> naming failed.
- **sparse comments. the code should document itself.** only load-bearing/ambiguous; design docs, not code.
- **performance is consistency, not just median.** hot path: narrow indexed lookups, no scans/joins; precompute once.
- **lazy by default, eager on the critical path.** wired eagerly, materialized lazily: first use, guarded once, memoized; invalidate on change; narrow slices, not whole graphs. init fails -> fail closed. laziness is the provider's secret.

## systems

scaled out: many nodes, partial failure normal, no shared clock; no single box load-bearing.

- **horizontal first.** identical stateless nodes; state in data tier.
- **APIs are stateless.** no state past the request; persist before response; any replica serves, restart mid-traffic; sessions in store.
- **build for fault tolerance and failures.** assume timeouts, crashes, partitions; design happy + partition paths.
- **decouple everything.** explicit contracts; producer never knows consumers; consumer replays log.
- **idempotent + replayable across nodes.** at-least-once -> dedup natural key; log = recovery + audit.
- **consensus only where correctness needs one truth.** replicas agreeing on ordering -> consensus (Raft: leader writes, committed on quorum; leader loss elect by term).
- **structural fix over compensation.** distributed bug = design bug; race -> change ownership.
- **cqrs for event driven systems.** separate writes/reads.

## security

attacker mindset; every new code path is attack surface; design the guard with the feature.

- **authorize at the boundary, not in the body.** validation layer is the guard; declarative layer so paths can't forget.
- **deny by default.** closed, open explicitly; allowlists > denylists; unknown refused.
- **fail closed on uncertain state.** stale/warming/missing/unverifiable refuse; default "no".
- **least privilege. separate capabilities.** read != write != extract; narrowest; operate-on != own.
- **derive authority from the source of truth, never a mutable counter.** canonical record; totals = accounting, not permission.
- **canonicalize untrusted input before you compare or act on it.** realpath before allowlist; URL host resolved, private/loopback/link-local rejected pre-fetch, rechecked across redirects.
- **never feed untrusted input to an interpreter.** SQL/shell/template/deserializer/regex/eval: parameterized/escaped only; data never code.
- **bound the work an untrusted caller can induce.** size/time/depth/rate caps; unbounded = DoS.
- **protect sensitive operations against replay.** nonce/idempotency key/signature consumed once; replays inert.
- **make dangerous operations total.** overflow/truncation/off-index: handle or abort; never wrap silently.
- **check and use atomically.** validate-then-act races; pin or revalidate at use.
- **defense in depth. independent, layered brakes.** no single check load-bearing; redundancy = design.
- **handle secrets as secrets.** never code/logs/errors; env or store; short-lived, scoped, redacted.
- **dependencies are attack surface you didn't write.** minimal, pinned, audited.
- **log every state mutation as a structured event. errors carry context.** event log = audit + reconstruction.

## testing

- **real programs > mocks.** e2e real deployment; fakes only at DI seam.
- **a test that never failed proves nothing.** encode invariant as failing test before implementation.
- **grade the suite, not just the code.** can't kill a mutant = decoration; audit greens.
- **property > example.** examples document intent; properties cover space; proofs where load-bearing.
- **concurrency is tested with schedules, not sleeps.** seeded, deterministic, adversarial; flaky = bug, never rerun.
- **boundaries are where code dies.** empty, first, last, max, half-open, off-by-one; test edges by name.
- **loadtest is correctness.** stress varying concurrency, real workloads.
- **behavioral testing should be main focus.** how code behaves in a real scenario; meaningful tests only.
- **tests should be adversarial.** users think differently; test cross-system interactions.
