# SPEC: kernel_fix — loud death, clean respawn, honest timeout

Status: planned (TDD). Implementation target: extensions/python-kernel.ts, tests in extensions/**tests**/python-kernel.test.mjs, one README line. No changes to kernel/kernel_host.py.

## Problem

An audit of the python kernel extension found four defects:

1. **Silent reset on quiescent death.** If the kernel process dies between calls (OOM, external kill), the exit handler fires but its evidence is discarded: the stderr tail is only delivered when a request happens to be in flight. The next call lazily respawns a fresh kernel and reports success with nothing indicating state was lost. The model then hits `NameError` and misattributes the cause to itself instead of a dead kernel.
2. **Stale buffers across respawns.** `buf` and `stderrTail` are reset only in `teardown()`, not in `start()`. A process that dies mid-line leaves a partial stdout fragment that concatenates with the next process's first reply, fails JSON parse, and is silently dropped. The first call after a dirty death then hangs until timeout. Stale stderr from a dead kernel likewise leaks into the next kernel's death message.
3. **Timeout message claims eager restart.** It says "kernel was restarted", but the restart is lazy (next dispatch). Minor, but it is the one message that is supposed to be loud and accurate.
4. **README overstates timeout precision.** It says "timeouts kill only their own cell". The code has no per-cell cancellation: timeout SIGKILLs the whole kernel and all state.

## Goal

An unexpected kernel death is always announced on the next call, with exit description and stderr tail. A respawn never inherits buffer state from a dead process. Messages and docs describe actual behavior. Host protocol unchanged.

## Design

### A. Death note (extensions/python-kernel.ts)

`Kernel` gains `lastDeath: { desc: string; stderr: string } | null`, set only by the unexpected-exit handler. `desc` is `signal <S>` when node reports a signal, else `code <n>`; node passes `(code, signal)` and a SIGKILL reports `code null, signal SIGKILL`, so the current "code null" text is useless. The exit handler's signature changes to `(code, signal)`.

`takeDeathNote()` consumes `lastDeath` (clearing it) and returns one line: `note: fresh kernel; previous kernel exited (<desc>); all previous variables are gone`, plus a `[stderr]` block with the tail when present. The tail rides the existing `STDERR_TAIL` bound; no second clip.

`dispatch` takes the note when it finds no live process, and attaches it to that dispatch's `Reply` via a new optional `note` field (also on the bootstrap-failure return). `render` emits the note as the first line. The note is one-shot: consumed at the respawn, never repeated.

Deliberate teardown (timeout restart, session shutdown) does not set `lastDeath`. Those paths already announce state loss in their own message; a follow-up note would be redundant. A spawn failure (`proc.on("error")`) sets no death either: nothing died, the next call simply retries bootstrap.

### B. Buffer ownership

`start()` resets `buf` and `stderrTail` before spawning: buffers belong to the current process, and a new process starts clean. The resets move out of `teardown()`; `start()` is the single owner.

### C. Injection seam

`Kernel` accepts optional constructor options `{ python?: string; host?: string }`, defaulting to the module constants `KERNEL_PYTHON` / `KERNEL_HOST`. This is the DI seam that lets tests drive hermetic fake hosts (counter-file scripts speaking the JSON-lines protocol) for dirty-death scenarios the real IPython host cannot produce deterministically. Production wiring is unchanged: the extension factory constructs `new Kernel()`.

### D. Timeout message

"timed out after Ns; kernel was restarted and all variables are gone" becomes "timed out after Ns; kernel will be restarted on the next call; all variables are gone". The lazy restart is the design; the message now matches it.

### E. README

The python bullet changes from "timeouts kill only their own cell" to: timeout kills the whole kernel (all state) and says so; an unexpected death is announced on the next call with exit description and stderr tail.

## Non-goals

- **No pre-use liveness probe.** The host's `ping` command stays as a future seam. The pending-map plus exit event already guarantee an in-flight request can never hang past a death.
- **No per-cell cancellation.** Timeout kills the whole kernel by design; cell state is session state, and partial cancellation is not expressible over the line protocol.
- **No retry or backoff after death.** One note, then the model decides.
- **No host changes.** kernel_host.py is correct as written.

## Test plan

TDD: each item lands red first, then green. Appended to python-kernel.test.mjs, real processes only, deterministic schedules (exit events, counter files), no sleeps. Full `npm test` must stay green at every step.

1. **Death note** (real kernel):
   - mid-call death: `import os; os._exit(9)`; the dying call errors with `kernel exited (code 9)`, and the next tool call's text starts with the note line (code 9, "all previous variables are gone") while still delivering its result;
   - quiescent death: SIGKILL the proc, await the exit event, next reply is ok and carries `note` containing `signal SIGKILL`;
   - the note is one-shot: the following call has no note;
   - a deliberate timeout restart produces no note on the next call.
2. **Injection seam**: `new Kernel({ python: "python3", host: <fake> })` runs a fake protocol host in a scratch dir (red until the constructor accepts options).
3. **Buffer reset** (fake host, per-spawn counter file):
   - dirty death: run 1 writes a partial line (no newline) and exits; run 2 speaks the protocol. Red pre-fix (run 2's reply is swallowed, call times out), green post-fix (expected output);
   - stale stderr: run 1 writes `old-error` to stderr and exits 4; run 2 exits 5 with a request in flight. The second death message matches `code 5` and must not contain `old-error`.
4. **Timeout message**: hung cell with `timeoutMs: 1500` matches `will be restarted on the next call`.
5. **README**: reread; no test.

No commit until reviewed.
