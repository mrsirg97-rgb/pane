# pane

**pane** — a clear pane for [pi](https://github.com/earendil-works/pi). Flat chrome, status glyphs, honest state. For you and your agent: same glass, both sides.

No fork. Eleven extensions on stock pi's public hooks; delete any file, get vanilla back.

```
● bash · $ node --test +1 lines
  171 passing
  0.4s

↑2.1k ↓15k · cache R50k W3.0k 92%
❯ your turn_
deepseek · max · 57k/393k 15% (auto)      main
```

## what's inside

one visual language, both directions. status glyphs `○ ◐ ● ✕` everywhere: tool rows, the todo queue, the prompt itself.

**your side of the glass**

- `builtin-restyle` — bash/read/write/edit/grep/find/ls re-rendered flat: `● tool · detail` headers, head/tail previews with expand hints, durations. write previews the written content, edit its diff. execution stays byte-identical stock (renderers swapped, nothing else).
- `footer` — throughput + cache on a row above the input; model · thinking · context (colored past 70/90%) below. pwd dropped; built for phone width.
- `input` — muted bars, prompt glyph carries state: accent `❯` your turn, dim `◐` agent streaming (typing = queue/steer).
- `scroll-speed` — fullscreen TUI wheel 3x (`PI_WHEEL_LINES` tunes). touch-scroll on mobile stops crawling.
- `themes/` — subtle-dark, subtle-light.

**the agent's side**

- `todo` — a concurrent job queue wearing a todo UI. enforced FSM (pending -> in_progress -> done | failed; failed -> retry), minted ids, several tasks in flight, batched transitions serialized against fresh state. illegal transitions return errors that teach the protocol. create accepts dependsOn (id or text) to build task trees: completion is gated by dependencies, cycles are refused, blocked tasks are skipped by next. move reorders the queue via minted-position events (1-based pos). every event is session-attributed with claim semantics: start claims, foreign complete refuses (fail it first to take over), fail frees. sqlite event log under the hood: idempotent create, replayable history, auto-compaction past 1000 events (full-state snapshot, epoch reset), corruption fails closed.
- `rem` — a memory tool: learn commits facts and constraints (idempotent, scoped global or per-project), recall is fuzzy/semantic search over past solutions with project-first global-fill, reflect stores distilled logs (and auto-parks compaction summaries), prune consolidates strength decay or removes/reduces. sqlite-backed, corruption quarantined aside, never deleted.
- `python` — persistent IPython kernel; state survives across calls; timeouts kill only their own cell.
- `web-search` + `web-fetch` — SearXNG search, guarded fetch: DNS refusal of private space with readable errors, redirects re-checked, byte/char caps with loud truncation markers, trafilatura extraction. optional egress proxy for connect-time enforcement.
- `tool-retry-guard` — 3 consecutive failures of one tool -> a note telling the model to stop retrying blindly.
- terse promptGuidelines throughout: the model's dashboard is prose-free, like yours.

`AGENTS.md` — the working contract these were built for. take it as a template.

170+ tests: `npm test` (runs `node --test __tests__/*.test.mjs`).

## install

```
git clone <this repo> && cd pane && npm install   # undici, for web-fetch's proxy path
pi install /path/to/pane
```

or copy `extensions/` into `~/.pi/agent/extensions/` and `themes/` into `~/.pi/agent/themes/`.

## bring your own

- **themes** copy themselves into `~/.pi/agent/themes/` on first launch (never overwriting yours); pick one in `/settings`.
- **python kernel** bootstraps itself on first use: creates `~/.pi/agent/kernel-venv` and installs ipython/numpy/pandas (needs `python3` + network; first call is slow once). `kernel_host.py` runs from the package; a copy at `~/.pi/agent/kernel/` overrides it.
- **web tools**: web-search expects SearXNG on `127.0.0.1:8888` (`PI_SEARXNG_URL` overrides); web-fetch routes through a proxy at `127.0.0.1:8889` (`PI_WEB_FETCH_PROXY=` empty fetches direct). a docker compose pairing (searxng + tinyproxy + DOCKER-USER egress firewall) is recommended, or tunnel both ports from a machine that has it.
- **trafilatura** on PATH upgrades web-fetch extraction; falls back to built-in tag-strip.

## caveats

- `builtin-restyle` and `scroll-speed` touch pi 0.84.1 exported internals. a pi update may wobble them; failure mode is stock look or a loud load error, never silent breakage. delete the file, restyle gone.
- cross-process todo writes (two pi sessions, same cwd) are last-writer-wins; WAL prevents corruption, and the event log makes races detectable, not lost silently.

## philosophy

lean both sides of the glass. every tool costs context, context costs tok/s, and fluff in a prompt is the same failure as clutter in a UI. state should be visible at a glance, transitions should be legal or loudly refused, and the chrome should be the thing you see through without noticing it's there.
